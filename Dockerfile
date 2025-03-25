FROM node:18-alpine AS builder

# Setup app directory
WORKDIR /app

# Install development dependencies
COPY package.json yarn.lock ./
COPY packages/docker-mate/package.json ./packages/docker-mate/
COPY packages/gluesync-sdk/package.json ./packages/gluesync-sdk/
RUN yarn install --frozen-lockfile

# Copy source files
COPY tsconfig.json ./
COPY packages/docker-mate ./packages/docker-mate/
COPY packages/gluesync-sdk ./packages/gluesync-sdk/

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

# Install production dependencies only
COPY package.json yarn.lock ./
COPY packages/docker-mate/package.json ./packages/docker-mate/
COPY packages/gluesync-sdk/package.json ./packages/gluesync-sdk/
RUN yarn install --frozen-lockfile --production

# Copy compiled JavaScript files
COPY --from=builder /app/packages/docker-mate/dist ./packages/docker-mate/dist
COPY --from=builder /app/packages/gluesync-sdk/dist ./packages/gluesync-sdk/dist

# Set environment variables
ENV NODE_ENV=production
ENV GLUESYNC_LICENSE_FILE=/opt/gluesync/data/gs-license.dat
ENV GLUESYNC_SECURITY_CONFIG=/opt/gluesync/data/security-config.json
ENV GLUESYNC_MODULE_TAG=container-mate
ENV HOST=0.0.0.0
ENV PORT=50000

# Expose the port
EXPOSE 50000

# Start the application
CMD ["node", "packages/docker-mate/dist/index.js"]
