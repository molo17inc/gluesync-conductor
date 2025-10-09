FROM node:22.13.1-alpine

# Install Docker CLI
RUN apk add --no-cache docker-cli docker-cli-compose curl

# Create Gluesync data directory structure
RUN mkdir -p /opt/gluesync/data

# Set environment variables
ENV NODE_ENV=production
ENV DKR_COMPOSE_FILE=docker-compose.yml
ENV DKR_COMPOSE_FILE_SOURCE=docker-compose.yml
ENV GLUESYNC_LICENSE_FILE=/opt/gluesync/data/gs-license.dat
ENV GLUESYNC_SECURITY_CONFIG=/opt/gluesync/data/security-config.json
ENV GLUESYNC_MODULE_TAG=gluesync-conductor
ENV COREHUB_UDP_PORT_RANGE=1717-1727
ENV HOST=0.0.0.0
ENV PORT=1717
ENV DOCKER_HOST=unix:///var/run/docker.sock
ENV CORE_HUB_NAME=gluesync-core-hub
ENV LOG_LEVEL=INFO
ENV USE_SDK=False
ENV SSL_SKIP_VERIFY=True
ENV SSL_ENABLED=False
ENV SSL_CERT_FILE=/opt/gluesync/data/cert.pem
ENV SSL_KEY_FILE=/opt/gluesync/data/key.pem
ENV IS_INTEGRATION_TEST=False
ENV GLUESYNC_CONFIG_DIR=.

# Setup app directory
WORKDIR /opt/gluesync-conductor

# Copy only the build
COPY build/index.js index.js
COPY build/index.js.map index.js.map
COPY build/static/ static/

COPY public/gluesync-conductor.svg static/logo.svg

EXPOSE 1717

CMD ["node","index.js"]
