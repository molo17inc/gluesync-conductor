FROM node:18-alpine AS builder

# Setup app directory
WORKDIR /app

# Install development dependencies
COPY package.json yarn.lock ./
COPY packages/docker-mate/package.json ./packages/docker-mate/
COPY packages/gluesync-sdk/package.json ./packages/gluesync-sdk/
COPY packages/gluesync-corehub-sdk/package.json ./packages/gluesync-corehub-sdk/
COPY .yarn ./.yarn
COPY .yarnrc.yml ./
RUN yarn install --frozen-lockfile

# Copy source files
COPY tsconfig.json ./
COPY packages/docker-mate ./packages/docker-mate/
COPY packages/gluesync-sdk ./packages/gluesync-sdk/
COPY packages/gluesync-corehub-sdk ./packages/gluesync-corehub-sdk/

# Build the application
RUN yarn workspaces run build

# Production image
FROM node:18-alpine

# Install docker CLI for docker-mate functionality
RUN apk add --no-cache docker

# Setup app directory
WORKDIR /app

# Create Gluesync data directory structure
RUN mkdir -p /opt/gluesync/data

# Copy only the built application
COPY --from=builder /app/packages/docker-mate/dist ./packages/docker-mate/dist

# Set environment variables
ENV NODE_ENV=production
ENV GLUESYNC_LICENSE_FILE=/opt/gluesync/data/gs-license.dat
ENV GLUESYNC_SECURITY_CONFIG=/opt/gluesync/data/security-config.json
ENV GLUESYNC_MODULE_TAG=gluesync-conductor
ENV COREHUB_UDP_PORT_RANGE=1717-1727
ENV HOST=0.0.0.0
ENV PORT=1717
ENV DOCKER_HOST=unix:///var/run/docker.sock

# Expose the port
EXPOSE 1717

# Create a volume for the Docker socket
VOLUME /var/run/docker.sock

# Start the application
CMD ["node", "packages/docker-mate/dist/index.js"]
