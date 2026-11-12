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

### Collect Logs

**POST /collect-logs**

Collects the logs of every container and the diagnostics of the environment
into an archive and sends it to MOLO17 support.

**Request body** (all fields optional):

| Field | Meaning |
|-------|---------|
| `voucher` | Support voucher of the ticket (`GSV-XXXX-XXXX-XXXX`, case and separators do not matter). The archive goes straight into that ticket through the support portal |
| `ticketId` | Legacy upload: ticket key (`GSSD-1234`, `1234` or `#1234`) |
| `email` | Legacy upload: e-mail of the person sending the logs |
| `localOnly` | `true` keeps the archive on the host and ignores every credential |

`voucher` cannot be combined with `ticketId` or `email` (`400`, `code: "validation"`).

With a voucher the portal checks it **before** anything is collected, the archive
is streamed to the portal in parts (never held in memory), and nothing falls back
to WebDAV, FTP or the legacy script. The archive is deleted only when the portal
confirms it holds every byte (`verified: true`); otherwise it stays and
`archivePath` says where. Without a voucher the legacy path runs unchanged:
WebDAV, then FTP, then the legacy script.

The portal address defaults to `https://api.support.molo17.com` and can be
overridden with `GLUESYNC_SUPPORT_API_URL` (a trailing slash is ignored).
Requests (the API and the storage uploads) go through `PROXY_HTTPS` /
`PROXY_HTTP` when they are set. The `User-Agent` carries `CONDUCTOR_VERSION`
when it is set.

**Response Format:**
```json
{
  "success": true,
  "output": "...",
  "uploadedVia": "portal",
  "ticketKey": "GSSD-1234",
  "size": 12894208,
  "verified": true
}
```

`uploadedVia` is `portal`, `webdav` or `ftp`. `archivePath` is present when the
archive was kept (local-only mode, or an upload the portal could not verify).

**Errors** are `{ "success": false, "error": "...", "details"?, "code"?, "maxBytes"? }`:

| Status | `code` | Meaning |
|--------|--------|---------|
| 400 | `validation` | `voucher` sent together with `ticketId` or `email` |
| 400 | `voucher_format` | The voucher is not `GSV-XXXX-XXXX-XXXX`; the portal was not called |
| 400 | `voucher_invalid` | Unknown or revoked voucher |
| 400 | `voucher_expired` | The ticket was closed more than 30 days ago |
| 400 | `file_too_large` | The archive exceeds what the portal takes (`maxBytes`, at most 5 GiB); the archive is kept |
| 429 | `rate_limited` | The portal is limiting requests from this host |
| 502 | `portal_unreachable` | The portal or its storage could not be reached; check the proxy and the firewall (the portal API and `*.s3.eu-central-1.amazonaws.com`) |
| 500 | none | Collection or archive failure |

## Updates: running pipelines go into maintenance mode

When an update (`POST /containers {"action": "update"}`) changes Core Hub's image, on Compose or on Swarm, the Conductor first puts every **running** pipeline into Core Hub's maintenance mode, which drains and stops sync gracefully, and takes the same pipelines out of it afterwards:

1. Once the services to update are known and before the compose/stack file is written, the Conductor lists the pipelines and pauses those that are configured, not already in maintenance mode, and have an entity syncing or migrating. Stopped pipelines, drafts and pipelines a user put in maintenance mode are left alone, and stay as they are after the update.
2. It waits until every paused pipeline reports maintenance mode. If that takes longer than `UPDATE_MAINTENANCE_DRAIN_TIMEOUT_SECONDS`, the update is refused with **409**, no image changes, and the pipelines paused so far are resumed (a pipeline still draining is resumed as soon as it gets there). If Core Hub refuses a command or cannot list the pipelines, the update is refused with **502**, with the same clean-up.
3. The pipelines are resumed as soon as Core Hub passes the stability check of the update (`UPDATE_VERIFY_SECONDS`), without waiting for the modules (Chronos, Grafana, Prometheus, the proxy), which carry no sync. If Core Hub fails and is rolled back, they are resumed on the previous version after the rollback.

The list of paused pipelines is written to `.conductor/update-paused-pipelines.json` next to the compose/stack file before the first pipeline is paused, and removed once all are resumed. A Conductor restarted in the middle of an update resumes them by itself once Core Hub answers (under the same lock as an update). Pipelines that could not be resumed stay in the file and are tried again at the next Conductor start or by the next update.

A Conductor self-update and an update of the modules alone do not pause anything. When Core Hub does not answer at all before the update (or has no pipeline API, before 2.2.9), the update goes on as before, without pausing, and the reply says so.

| Variable | Default | Meaning |
|---|---|---|
| `UPDATE_MAINTENANCE_DRAIN_TIMEOUT_SECONDS` | `300` | How long the running pipelines have to report maintenance mode before the update is refused |
| `UPDATE_MAINTENANCE_RESUME_TIMEOUT_SECONDS` | `300` | How long the Conductor keeps trying to resume them (Core Hub restarting, the SDK reconnecting) before it leaves them in the file for later |
| `UPDATE_PIPELINE_MAINTENANCE` | `true` | `false` turns the whole behaviour off |

Core Hub's item in the reply carries two more fields (nothing else changes):

```json
{
  "id": "gluesync-core-hub",
  "status": "OK",
  "message": "Agent gluesync-core-hub updated and restarted.",
  "pausedPipelines": ["8a1f…", "c03e…"],
  "resumedPipelines": ["8a1f…", "c03e…"]
}
```

Core Hub endpoints used (gluesync-kotlin `corehub/src/main/kotlin/com/molo17/gluesync/corehub/server/route/rest/`), with the token Core Hub gives the Conductor in the module handshake (role `EXTERNAL_MODULE`, which may start and stop replication):

| Call | Source |
|---|---|
| `GET /pipelines` (`isInMaintenanceMode`, `configurationCompleted`) | `PipelinesRoutes.kt` `basicPipelinesRoute`, `PipelineResponseDto` in commons-model |
| `GET /pipelines/{id}/entities-status` (`isSyncActive`, `isMigrationActive`) | `PipelinesRoutes.kt`, `EntityStatus` in commons-model |
| `POST /pipelines/{id}/commands/maintenance/enter` and `/exit` | `SyncCommandRoutes.kt` `maintenanceRoutes`, mounted by `RestRoutes.kt` `commandRoutes` |

## Docker Labels

Gluesync Conductor uses Docker labels to identify and track containers. The following labels are used:

### 1. Service ID Label

**Label:** `com.molo17.conductor.service_id`

This label stores the container's id, which serves as a unique identifier. It helps Gluesync Conductor identify which containers are persisted in the Docker Compose configuration file.

**Example:**
```yaml
labels:
  - "com.molo17.conductor.service_id=my-container-id"
```

### 2. Agent Type Label

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

## Container engines

Docker is the default engine. Podman (rootful and rootless, Linux) is supported
through its Docker-compatible socket: see [Conductor on Podman](./packages/gluesync-conductor/docs/podman.md)
for the socket matrix, the kit `.env` keys, SELinux options and what is not
supported (Swarm). Docker Swarm stacks are described in
[Conductor on Docker Swarm](./packages/gluesync-conductor/docs/swarm-mode.md).

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
