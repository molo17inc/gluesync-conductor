# Gluesync Conductor

![Gluesync Conductor Logo](./docs/assets/gluesync-conductor.svg)

## Overview

Gluesync Conductor is the orchestration module for all platform modules and components within the Gluesync ecosystem. It provides a streamlined interface for managing Docker containers and services without requiring direct interaction with YAML files or Docker commands.

## Description

Gluesync Conductor serves as the central orchestrator for all platform modules and components. It enables users to perform updates, add new components, and execute maintenance tasks directly from the user interface without needing to work with YAML files or directly with Docker. The system will automatically notify you when component updates are available.

## Key Features

- **Centralized Container Management**: Control all your Docker containers from a single interface
- **Automatic Updates**: Receive notifications when component updates are available
- **Component Installation**: Add new components with a few clicks
- **Maintenance Operations**: Perform maintenance tasks directly from the UI
- **API-Driven Architecture**: All operations exposed via RESTful API
- **Comprehensive Documentation**: Interactive Swagger UI for exploring APIs

## Installation

### Prerequisites

- Node.js 16 or higher
- Docker and Docker Compose
- Yarn package manager

### Quick Start

```bash
# Clone the repository
git clone https://github.com/molo17srl/gluesync-conductor.git
cd gluesync-conductor

# Install dependencies
yarn install

# Start the service
cd packages/docker-mate
PORT=50001 yarn dev
```

## Usage

Once the service is running, you can access:

- API endpoints: [http://localhost:50001/](http://localhost:50001/)
- API documentation: [http://localhost:50001/docs](http://localhost:50001/docs)

For standalone documentation:

```bash
node serve-docs.js
```

This will serve the API documentation on [http://localhost:8080](http://localhost:8080).

## API Documentation

The project uses Swagger to document all available API endpoints. You can access the interactive documentation by:

1. Starting the service `PORT=50001 yarn dev`
2. Opening a browser at [http://localhost:50001/docs](http://localhost:50001/docs)

Alternatively, you can start the standalone documentation server:

```bash
node serve-docs.js
```

## Architecture

Gluesync Conductor is built with a modular architecture using Fastify for high-performance API services. It consists of the following components:

- **API Server**: Provides RESTful endpoints for container management
- **Docker Plugin**: Interfaces with Docker Engine for container operations
- **Swagger Integration**: Provides interactive API documentation

## Development

```bash
# Run development server with auto-reload
cd packages/docker-mate
PORT=50001 yarn dev

# Run tests
yarn test

# Build for production
yarn build
```

## License

This project is dual-licensed under the following licenses:

### 1. GNU General Public License (GPL) Version 3

You may use, modify, and distribute this software under the terms of the GPL v3.
See the LICENSE-GPL file or [http://www.gnu.org/licenses/gpl-3.0.html](http://www.gnu.org/licenses/gpl-3.0.html) for details.
This option is available at no cost, but any derivative works must also be licensed under GPL v3.

### 2. MOLO17 Commercial License

Alternatively, you may use this software under the MOLO17 Commercial License,
which includes a warranty and permits proprietary use. Contact MOLO17 at info@molo17.com
for licensing terms and conditions.

You must choose one of these licenses to use this software. Using this software implies
acceptance of one of these licenses. See the accompanying LICENSE files or contact
MOLO17 for more information.

Copyright (C) 2025 MOLO17. All rights reserved.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. Please ensure your code follows the project's code style and includes appropriate tests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Contact

MOLO17 - [info@molo17.com](mailto:info@molo17.com)

Project Link: [https://github.com/molo17srl/gluesync-conductor](https://github.com/molo17srl/gluesync-conductor)
