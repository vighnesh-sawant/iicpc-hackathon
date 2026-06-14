#!/bin/bash
set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}=== IICPC E2E Infrastructure Test ===${NC}"

# Ensure teardown on exit
cleanup() {
    echo -e "${YELLOW}Tearing down infrastructure...${NC}"
    if [ -n "${PF_PID:-}" ]; then kill "$PF_PID" 2>/dev/null || true; fi
    ./manage_infra.sh down >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. Compile dummy engine
echo -e "${CYAN}[1/5] Compiling dummy engine...${NC}"
make -C engine clean >/dev/null
make -C engine >/dev/null

# 2. Bring up infra
echo -e "${CYAN}[2/5] Bringing up infrastructure...${NC}"
./manage_infra.sh up >/dev/null

# 3. Port forward to backend
echo -e "${CYAN}[3/5] Starting port-forward to backend...${NC}"
kubectl port-forward svc/backend 3001:3001 >/dev/null 2>&1 &
PF_PID=$!
sleep 5 # Wait for port forward to establish

# Wait until backend API is fully responsive
echo -e "${CYAN}Waiting for backend to be ready...${NC}"
for i in {1..30}; do
    if curl -s http://localhost:3001/api/health | grep -q "healthy"; then
        echo -e "${GREEN}Backend is reachable.${NC}"
        break
    fi
    sleep 2
    if [ $i -eq 30 ]; then
        echo -e "${RED}Backend never became reachable.${NC}"
        exit 1
    fi
done

# 4. Trigger test
echo -e "${CYAN}[4/5] Registering user and uploading binary...${NC}"
curl -sf -X POST http://localhost:3001/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"ci_tester","password":"ci_password"}' >/dev/null || true

UPLOAD_RES=$(curl -sf -X POST http://localhost:3001/api/upload \
  -F "username=ci_tester" \
  -F "binary=@engine/dummy_engine" || echo '{"error":"upload failed"}')

# Very simple grep to extract runId instead of python3 to keep dependencies minimal
RUN_ID=$(echo "$UPLOAD_RES" | grep -o '"runId":"[^"]*' | cut -d'"' -f4 || true)

if [ -z "$RUN_ID" ]; then
    echo -e "${RED}Upload failed or no runId returned! Response: $UPLOAD_RES${NC}"
    exit 1
fi
echo -e "${GREEN}Uploaded successfully. Run ID: $RUN_ID${NC}"

# 5. Wait for pipeline
echo -e "${CYAN}[5/5] Waiting for pipeline to complete...${NC}"
STATUS="unknown"
for i in {1..60}; do
    PROFILE=$(curl -sf http://localhost:3001/api/profile/ci_tester || echo '{"runs":[]}')
    
    # We look for the status field immediately following our runId.
    STATUS=$(echo "$PROFILE" | grep -o "\"id\":\"$RUN_ID\"[^{]*\"status\":\"[^\"]*" | grep -o '[^"]*$' || echo "unknown")
    
    printf "\r  Polling... %ds elapsed. Status: %s " $((i*2)) "$STATUS"
    if [[ "$STATUS" == "completed" || "$STATUS" == "failed" ]]; then
        echo ""
        break
    fi
    sleep 2
done
echo ""

if [[ "$STATUS" == "completed" ]]; then
    echo -e "${GREEN}✓ Test Passed! Pipeline completed successfully.${NC}"
    exit 0
else
    echo -e "${RED}✗ Test Failed! Pipeline status: $STATUS${NC}"
    exit 1
fi
