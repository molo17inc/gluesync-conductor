# Gluesync Conductor - Container Management API

![Gluesync Conductor Logo](./packages/gluesync-conductor/public/gluesync-conductor.svg)

## Overview

Gluesync Conductor is a container management platform that provides a comprehensive RESTful API for managing Docker containers, with a focus on flexible configuration and consistent response formats.

## Features

- **Container Listing**: Get detailed information about all containers
- **Container Details**: Retrieve configuration for specific containers
- **Container Management**: Add, update, and manage containers
- **Version Checking**: Check for available container updates
- **Container Persistence**: Track which containers are persisted in configuration
- **Docker Label Integration**: Use Docker labels for container identification
- **Gluesync SDK Integration**: Connect to CoreHub for advanced orchestration capabilities

## Installation

### Prerequisites

- Node.js 16 or higher
- Docker and Docker Compose
- Yarn package manager

### Quick Start

```bash
# Install dependencies
cd packages/gluesync-conductor
yarn install

# Start the service
PORT=50015 yarn dev
```

## Available Scripts

### Code Quality
- **`yarn format`** - Format all files using Prettier
- **`yarn format:check`** - Check if files are properly formatted
- **`yarn format:write`** - Format files and write changes
- **`yarn lint`** - Run ESLint across all workspaces
- **`yarn lint:fix`** - Auto-fix ESLint issues across workspaces

### Development
- **`yarn type-check`** - Run TypeScript type checking across workspaces
- **`yarn build`** - Build all packages in topological order
- **`yarn do`** - Complete setup: install → build → type-check

### Documentation
- **`yarn get-openapi`** - Generate OpenAPI documentation from gluesync-conductor service


## API Endpoints

The Gluesync Conductor API provides the following endpoints for container management:

### Container Listing

**GET /containers**

Returns a list of all containers with detailed information including:

- Container ID
- Name
- Image
- Tag
- Version Tag (from labels)
- Persistence status
- Running status
- Creation time
- Status
- Ports
- Environment variables

**Response Format:**

```json
{
  "success": true,
  "data": [
    {
      "id": "1eab590c0dbfa0c1cd8e8e67a1f9cefc0b8f4909b4e2a0981eab6de0d5867529",
      "name": "gluesync-agent",
      "image": "molo17/gluesync-agent",
      "tag": "latest",
      "versionTag": "1.2.3",
      "persisted": true,
      "created": "2025-04-10T14:23:45.000Z",
      "running": true,
      "status": "running",
      "ports": ["8080:8080"],
      "environment": {
        "GLUESYNC_MODULE_TAG": "conductor"
      }
    }
  ]
}
```

### Get Container

**GET /containers/{id}**

Retrieves detailed configuration for a specific container by its ID.

**Response Format:**
```json
{
  "success": true,
  "data": {
    "imageName": "gluesync-agent",
    "type": "target",
    "nickname": "gluesync-agent",
    "tag": "latest",
    "versionTag": "1.2.3",
    "persisted": true,
    "environment": {
      "GLUESYNC_MODULE_TAG": "conductor",
      "type": "target",
      "maxRamPercentage": 90.0
    },
    "ports": ["8080:8080"],
    "volumes": ["/data:/app/data"]
  }
}
```

### Get Container Version

**GET /containers/{id}/version**

Checks for the latest available version of a container from the MOLO17 backoffice API.

**Response Format:**
```json
{
  "success": true,
  "data": {
    "container": {
      "id": "1eab590c0dbfa0c1cd8e8e67a1f9cefc0b8f4909b4e2a0981eab6de0d5867529",
      "name": "gluesync-agent",
      "image": "molo17/gluesync-agent",
      "tag": "latest"
    },
    "version": {
      "current": "1.2.3",
      "latest": "1.3.0",
      "updateAvailable": true
    }
  }
}
```

### Add Container

**POST /containers**

Adds one or more containers to the system. Containers are added to the Docker Compose file and can be started separately.

**Request Format:**

```json
{
  "containers": [
    {
      "imageName": "gluesync-agent",
      "type": "target",
      "nickname": "my-agent",
      "tag": "1.2.3",
      "environment": {
        "DEBUG": "true"
      },
      "ports": ["8080:8080"],
      "volumes": ["/data:/app/data"]
    }
  ]
}
```

**Response Format:**
```json
{
  "success": true,
  "data": {
    "message": "Containers added successfully"
  }
}
```

### Update Container

**PUT /containers/{id}**

Updates the configuration of an existing container.

**Request Format:**

```json
{
  "imageName": "gluesync-agent",
  "type": "target",
  "nickname": "updated-agent",
  "tag": "1.3.0",
  "environment": {
    "DEBUG": "false"
  },
  "ports": ["9090:8080"],
  "volumes": ["/new-data:/app/data"]
}
```

**Response Format:**
```json
{
  "success": true,
  "data": {
    "message": "Container updated successfully"
  }
}
```

### Pull Container Image

**POST /containers/{id}/pull**

Pulls the latest version of the image for a specific container from Docker Hub or the configured registry.

**Response Format:**
```json
{
  "success": true,
  "data": [
    "Pulling from molo17/gluesync-agent",
    "Digest: sha256:1234567890abcdef...",
    "Status: Downloaded newer image for molo17/gluesync-agent:latest"
  ]
}
```

### Restart Container

**POST /containers/{id}/restart**

Gracefully restarts a container with a 10-second timeout.

**Response Format:**
```json
{
  "success": true,
  "data": [
    "Container 1eab590c0dbf restarted successfully"
  ]
}
```

## Docker Labels

Gluesync Conductor uses Docker labels to identify and track containers. The following labels are used:

### 1. Unique ID Label

**Label:** `com.molo17.conductor.unique_id`

This label stores the container's nickname, which serves as a unique identifier. It helps Gluesync Conductor identify which containers are persisted in the Docker Compose configuration file.

**Example:**
```yaml
labels:
  - "com.molo17.conductor.unique_id=my-agent"
```

### 2. Version Tag Label

**Label:** `com.molo17.conductor.versiontag`

This label stores the version tag of the container as specified by the user during container creation or update. It helps track the current version of the container, which may differ from the tag in the image name.

**Example:**
```yaml
labels:
  - "com.molo17.conductor.versiontag=1.2.3"
```

### 3. Agent Type Label

**Label:** `com.molo17.conductor.type`

This label identifies the container as an agent managed by Gluesync Conductor. It is automatically set to `agent` for all agent containers created through the API.

**Example:**
```yaml
labels:
  - "com.molo17.conductor.type=agent"
```

## HTTPS Support

Gluesync Conductor supports HTTPS for secure communication. The HTTPS implementation includes:

- Automatic HTTP to HTTPS redirection for browsers
- Support for TLS certificates
- Configurable SSL verification

### Configuration

HTTPS support is configured using environment variables:

- `SSL_ENABLED`: Set to `true` to enable HTTPS (default: `false`)
- `SSL_CERT_FILE`: Path to the SSL certificate file
- `SSL_KEY_FILE`: Path to the SSL private key file
- `SSL_SKIP_VERIFY`: Set to `true` to skip certificate verification (default: `true`)

### Example Usage

```bash
# Start with HTTPS enabled
SSL_ENABLED=true SSL_CERT_FILE=/path/to/cert.pem SSL_KEY_FILE=/path/to/key.pem PORT=50002 yarn dev
```

### Certificate Notes

- For development, you can generate self-signed certificates using OpenSSL
- For production, use certificates from a trusted certificate authority
- When using self-signed certificates in Chrome, you may need to type "thisisunsafe" when the certificate warning appears
- For Firefox, you may need to add a security exception

## Gluesync SDK Integration

Gluesync Conductor integrates with the Gluesync SDK to enable communication with CoreHub for advanced container orchestration capabilities.

### Configuration

The Gluesync SDK integration is configured using environment variables:

- `GLUESYNC_LICENSE_FILE`: Path to the Gluesync license file (default: `/opt/gluesync/data/gs-license.dat`)
- `GLUESYNC_SECURITY_CONFIG`: Path to the security configuration file (default: `/opt/gluesync/data/security-config.json`)
- `COREHUB_UDP_PORT_RANGE`: Port range for CoreHub discovery (default: `1718-1727`, recommended: `1717-1727`)

### Connection Management

The integration handles CoreHub connections with the following features:

- Automatic initialization on server startup
- Graceful shutdown on server termination
- Proper error handling and logging

## Persistence Management

Gluesync Conductor tracks which containers are persisted in the Docker Compose configuration file. This information is exposed through the `persisted` field in container responses.

- **persisted: true** - The container is defined in the Docker Compose file
- **persisted: false** - The container exists in Docker but is not defined in the Docker Compose file

This allows you to distinguish between containers that were created through the Gluesync Conductor API and those that were created by other means.

## YAML File Handling

Gluesync Conductor uses a fixed YAML file named `docker-compose.yml` located at the project root. This file stores the container configurations and is used to determine which containers are persisted.

You can provide your own YAML file by:

1. Placing a file named `docker-compose.yml` in the project root
2. Setting the `PROJECT_CWD` environment variable to point to a directory containing your YAML file

```bash
PROJECT_CWD=/path/to/your/directory PORT=50015 yarn dev
```

## Integration Guide

For detailed integration flows and code examples showing how to use the Gluesync Conductor API in your applications, see the [Integration Flows Guide](./packages/gluesync-conductor/docs/integration-flows.md). This guide includes:

- Diagrams for container addition and update workflows
- Code examples for common operations
- Best practices for API integration
- Complete integration examples with error handling

## Development

```bash
# Run development server with auto-reload (HTTP)
PORT=50015 yarn dev

# Run development server with HTTPS
SSL_ENABLED=true SSL_CERT_FILE=./certs/cert.pem SSL_KEY_FILE=./certs/key.pem PORT=50015 yarn dev

# Run with CoreHub discovery port range
COREHUB_UDP_PORT_RANGE=1717-1727 PORT=50015 yarn dev

# Run tests
yarn test

# Build for production
yarn build
```

## License

This project is dual-licensed under the GNU General Public License (GPL) Version 3 and the MOLO17 Commercial License. See the main project README for details.

Copyright (C) 2025 MOLO17. All rights reserved.
