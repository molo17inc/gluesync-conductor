FROM node:24.16.0-alpine
WORKDIR /fake
RUN npm init -y >/dev/null && npm install --no-audit --no-fund ws@8.18.0 >/dev/null
COPY fake.mjs ./fake.mjs
ENV FAKE_ROLE=http
HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=5 CMD test -f /fake/ready
ENTRYPOINT ["node", "/fake/fake.mjs"]
