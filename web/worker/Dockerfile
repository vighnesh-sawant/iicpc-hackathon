FROM node:18-bookworm
WORKDIR /app

# Install build dependencies for the C++ engine, bot_fleet, and nsjail
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential \
    git bison flex gcc g++ make \
    libprotobuf-dev libnl-route-3-dev protobuf-compiler pkg-config \
    iproute2 sudo

# Build and install nsjail
RUN git clone https://github.com/google/nsjail.git /tmp/nsjail && \
    cd /tmp/nsjail && \
    make && \
    mv nsjail /usr/bin/ && \
    rm -rf /tmp/nsjail

# Copy and build engine
COPY engine /engine
RUN make -C /engine clean && make -C /engine

# Setup worker
WORKDIR /app/worker
COPY web/worker/package*.json ./
RUN npm install
COPY web/worker/ .

# Environment vars
ENV BOT_FLEET_PATH=/engine/bot_fleet
ENV WORK_DIR=/app/temp_uploads

CMD ["node", "worker.js"]
