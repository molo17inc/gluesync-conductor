FROM node:24.22.1-alpine
WORKDIR /fake
# `ws` is one of the sandbox's own npm dependencies (sandbox/package.json). setup.mjs stages it
# next to this file as ./ws, so the build downloads nothing: no npm registry.
RUN chown node:node /fake
COPY --chown=node:node ws ./node_modules/ws
COPY --chown=node:node fake.mjs ./fake.mjs
ENV FAKE_ROLE=http
# The fakes need no privileges: the ready file is written under /fake, which
# `node` owns, and containers may bind low ports without root.
USER node
HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=5 CMD test -f /fake/ready
ENTRYPOINT ["node", "/fake/fake.mjs"]
