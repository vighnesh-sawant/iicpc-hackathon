#!/bin/bash
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "$1" == "up" ]; then
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║  IICPC Infrastructure UP                                   ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"

    echo -e "\n${CYAN}[1/3] Building Docker Images...${NC}"
    echo "Building backend..."
    docker build -t iicpc-backend:latest -f web/backend/Dockerfile web/backend/
    
    echo "Building frontend..."
    docker build -t iicpc-frontend:latest -f web/frontend/Dockerfile web/frontend/
    
    echo "Building worker..."
    docker build -t iicpc-worker:latest -f web/worker/Dockerfile .

    echo -e "\n${CYAN}[2/3] Loading Images into K8s Cluster...${NC}"
    docker save iicpc-backend:latest | docker exec -i iicpc-cluster-control-plane ctr -n k8s.io images import -
    docker save iicpc-frontend:latest | docker exec -i iicpc-cluster-control-plane ctr -n k8s.io images import -
    docker save iicpc-worker:latest | docker exec -i iicpc-cluster-control-plane ctr -n k8s.io images import -

    echo -e "\n${CYAN}[3/3] Applying K8s Manifests...${NC}"
    kubectl apply -f k8s/

    echo -e "\n${CYAN}Waiting for pods to be ready...${NC}"
    kubectl wait --for=condition=ready pod -l app=minio --timeout=120s || true
    kubectl wait --for=condition=ready pod -l app=kafka --timeout=120s || true
    kubectl wait --for=condition=ready pod -l app=postgres --timeout=120s || true
    kubectl wait --for=condition=ready pod -l app=backend --timeout=120s || true
    kubectl wait --for=condition=ready pod -l app=frontend --timeout=120s || true
    kubectl wait --for=condition=ready pod -l app=worker --timeout=120s || true

    echo -e "\n${GREEN}✓ Infrastructure is UP and READY!${NC}"

elif [ "$1" == "down" ]; then
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║  IICPC Infrastructure DOWN                                 ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"

    echo -e "\n${CYAN}Deleting all k8s resources in k8s/ folder...${NC}"
    kubectl delete -f k8s/ --ignore-not-found=true

    echo -e "\n${GREEN}✓ Infrastructure is DOWN!${NC}"
else
    echo "Usage: $0 {up|down}"
    exit 1
fi
