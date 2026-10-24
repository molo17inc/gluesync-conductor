# Image of the `sandbox` CI job (.gitlab-ci.yml, ci/sandbox-job.sh): docker:dind plus everything the
# job needs, so it downloads no package at run time. Hosted in Nexus (molo17-local), because the
# runners must not reach Docker Hub or the npm registry.
#
# Rebuild and push, from the repository root, whenever this file, sandbox/package.json,
# sandbox/package-lock.json or the root packageManager changes; bump the tag here, in
# .gitlab-ci.yml and in sandbox/README.md ("In CI") together:
#
#   docker buildx build --platform linux/amd64,linux/arm64 --provenance=false --sbom=false \
#     -f ci/sandbox-ci.Dockerfile \
#     --build-arg SOURCE_COMMIT=$(git rev-parse --short HEAD) \
#     -t nexus.hq.molo17.com/molo17-local/conductor-sandbox-ci:1 --push .
FROM nexus.hq.molo17.com/molo17-local/docker:28.3.3-dind

# Must equal "packageManager" in the root package.json (checked below, the build fails otherwise).
ARG YARN_VERSION=4.6.0
ARG COREPACK_VERSION=0.34.0
ARG SOURCE_COMMIT=unknown

LABEL org.opencontainers.image.title="conductor-sandbox-ci" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"

# Alpine's nodejs ships no corepack. COREPACK_HOME is fixed so the prepared yarn is found by
# whichever user runs the job.
ENV COREPACK_HOME=/opt/corepack
RUN apk add --no-cache nodejs npm \
 && npm install --global --no-audit --no-fund corepack@${COREPACK_VERSION} \
 && corepack enable \
 && corepack prepare yarn@${YARN_VERSION} --activate

# The sandbox's own npm dependencies; the job links sandbox/node_modules to this directory.
COPY sandbox/package.json sandbox/package-lock.json /opt/sandbox-deps/
RUN cd /opt/sandbox-deps && npm ci --omit=dev --no-audit --no-fund

# The yarn above must be the one the repository asks for.
COPY package.json /tmp/root-package.json
RUN node -e '\
const want = "yarn@" + process.argv[1];\
const got = require("/tmp/root-package.json").packageManager;\
if (got !== want) { console.error("root package.json packageManager is " + got + ", this image has " + want + ": rebuild with --build-arg YARN_VERSION"); process.exit(1); }' "${YARN_VERSION}" \
 && rm /tmp/root-package.json

# Anything that would download at run time (yarn through corepack) fails loudly instead.
ENV COREPACK_ENABLE_NETWORK=0 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
