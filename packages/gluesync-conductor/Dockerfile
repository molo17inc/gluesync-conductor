FROM node:24.22.1-alpine

# ALPINE_MIRROR (optional, set by CI): an Alpine package mirror (for example a Nexus proxy of
# https://dl-cdn.alpinelinux.org/alpine) to download from instead of the Alpine CDN. Only this
# build uses it: the image keeps the default /etc/apk/repositories, and a mirror that fails falls
# back to the default repositories.
ARG ALPINE_MIRROR=

# Upgrade base OS packages, then install Docker CLI and tzdata for timezone support.
# The runtime only runs `node index.js`: drop npm, npx, corepack and yarn (and
# their bundled dependencies) to remove their CVE surface from the image.
# Create Gluesync data and logs directory structure with proper permissions.
RUN apk_install() { \
      apk upgrade --no-cache "$@" \
      && apk add --no-cache "$@" docker-cli docker-cli-compose curl bash zip tar tzdata yq zstd xz pigz; \
    } \
  && if [ -n "$ALPINE_MIRROR" ]; then \
      sed -E "s#^https?://[^/]+/alpine#${ALPINE_MIRROR%/}#" /etc/apk/repositories > /tmp/apk-mirror \
      && { apk_install --repositories-file /tmp/apk-mirror \
        || { echo "Alpine mirror $ALPINE_MIRROR failed: using the default repositories"; apk_install; }; } \
      && rm -f /tmp/apk-mirror; \
    else \
      apk_install; \
    fi \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
  && mkdir -p /opt/gluesync/data /opt/gluesync/logs \
  && chown -R node:node /opt/gluesync

# The version this image was released as (set by CI). Conductor reports it to
# the support portal with log bundles and in its User-Agent; without it the
# portal shows the version as "unknown".
ARG CONDUCTOR_VERSION=
ENV CONDUCTOR_VERSION=${CONDUCTOR_VERSION}

# Set environment variables
ENV NODE_ENV=production
ENV DKR_COMPOSE_FILE=docker-compose.yml
ENV DKR_COMPOSE_FILE_SOURCE=docker-compose.yml
ENV GLUESYNC_LICENSE_FILE=/opt/gluesync/data/gs-license.dat
ENV GLUESYNC_SECURITY_CONFIG=/opt/gluesync/data/security-config.json
ENV COREHUB_UDP_PORT_RANGE=1717-1727
ENV HOST=0.0.0.0
ENV PORT=1717
ENV DOCKER_HOST=unix:///var/run/docker.sock
ENV CORE_HUB_NAME=gluesync-core-hub
ENV LOG_LEVEL=INFO
ENV USE_SDK=true
ENV SSL_SKIP_VERIFY=true
ENV SSL_ENABLED=true
ENV SSL_CERT_FILE=/opt/gluesync/data/gluesync-cert.pem
ENV SSL_KEY_FILE=/opt/gluesync/data/gluesync-key.pem
ENV MOUNT_LEGACY_FILE_CONFIG=false
ENV GLUESYNC_CONFIG_DIR=./shared

# Setup app directory
WORKDIR /opt/gluesync-conductor

# Copy only the build
COPY build/index.js index.js
COPY build/index.js.map index.js.map
COPY build/static/ static/

COPY agents.json agents.json

# Copy log uploader scripts FROM build output
COPY build/collect-logs.sh collect-logs.sh
COPY build/system-info.sh system-info.sh

# Set executable permission for scripts
RUN chmod +x collect-logs.sh system-info.sh

# Dockerfile snippet
COPY build/copy-agent-data.sh copy-agent-data.sh
RUN chmod +x copy-agent-data.sh

COPY public/gluesync-conductor.svg static/logo.svg

EXPOSE 1717

CMD ["node","index.js"]
