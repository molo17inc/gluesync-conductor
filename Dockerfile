FROM node:22.13.1-alpine

RUN corepack enable

WORKDIR /opt/repo

COPY package.json yarn.lock .pnp.cjs .pnp.loader.mjs .yarnrc.yml ./
COPY tsconfig.json typings.d.ts ./
COPY .yarn .yarn
COPY packages packages

RUN yarn install --immutable --immutable-cache
RUN yarn build

# The built artifacts will be in /opt/repo/packages/**/build and /opt/repo/packages/**/lib
