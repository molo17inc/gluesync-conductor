# Gluesync Node.js SDK

A Node.js client-side SDK for connecting to Gluesync CoreHub services. This SDK enables external modules to establish authenticated WebSocket connections with Gluesync CoreHub, implementing the handshake process required for secure communication.

## Features

- **Secure WebSocket Connections**: Support for both WS and WSS using JKS certificates
- **Automated Handshake Process**: Handles the complete authentication flow with Gluesync CoreHub
- **License Management**: Validates and processes license files required for authentication
- **Keep-Alive Mechanism**: Implements ping/pong protocol to maintain persistent connections
- **UDP Autodiscovery**: Automatically discovers CoreHub on the local network
- **Promise-based API**: Built on top of modern async JavaScript/TypeScript
- **Cross-Platform Compatibility**: Works on Linux, macOS, and Windows
- **TypeScript Support**: Includes type definitions for improved developer experience

## Installation

```bash
npm install gluesync-sdk
# or
yarn add gluesync-sdk
```

## Quick Start

```typescript
import { GluesyncClient } from 'gluesync-sdk';

async function main() {
  // Initialize the client with CoreHub address and license file path
  // For fixed address:
  const client = new GluesyncClient({
    host: 'localhost',
    port: 1717,
    licenseFilePath: '/path/to/gs-license.dat',
    moduleTag: 'my-module'
  });
  
  // Or use UDP autodiscovery (set host to null)
  // const client = new GluesyncClient({
  //   host: null,  // Will use UDP autodiscovery to find CoreHub
  //   port: 1717,
  //   licenseFilePath: '/path/to/gs-license.dat',
  //   moduleTag: 'my-module'
  // });
  
  // Connect to CoreHub
  await client.connect();
  
  // The JWT token for API requests is available after connection
  const jwtToken = client.token;
  console.log(`Connected with token: ${jwtToken}`);
  
  // Do your work here
  
  // Disconnect when done
  await client.disconnect();
}

main().catch(console.error);
```

## Advanced Usage

### Using UDP Autodiscovery

The SDK can automatically discover CoreHub on the local network using UDP:

```typescript
import { GluesyncClient } from 'gluesync-sdk';

async function main() {
  // Initialize the client without specifying a host to use autodiscovery
  const client = new GluesyncClient({
    // host parameter is omitted to enable autodiscovery
    licenseFilePath: '/path/to/gs-license.dat',
    moduleTag: 'my-module'
  });
  
  // Connect will automatically discover the CoreHub on the network
  await client.connect();
  
  // Do your work here
  
  // Disconnect when done
  await client.disconnect();
}

main().catch(console.error);
```

You can also use the environment variable `CORE_HUB_ADDRESS` to bypass autodiscovery:

```typescript
// Set this to bypass autodiscovery
process.env.CORE_HUB_ADDRESS = '192.168.1.100';
```

### Using SSL/TLS with JKS Certificates

```typescript
import { GluesyncClient } from 'gluesync-sdk';

async function main() {
  const client = new GluesyncClient({
    host: 'corehub.example.com',
    port: 1717,
    licenseFilePath: '/path/to/gs-license.dat',
    moduleTag: 'my-module',
    ssl: true,
    keystorePath: '/path/to/Gluesync.com.jks',
    keystorePassword: 'your-password'
  });
  
  await client.connect();
  // ...
}

main().catch(console.error);
```

### Setting Up Event Handlers

```typescript
import { GluesyncClient } from 'gluesync-sdk';

// Option 1: Using callback functions
async function main() {
  const client = new GluesyncClient({
    host: 'localhost',
    port: 1717,
    licenseFilePath: '/path/to/gs-license.dat',
    moduleTag: 'my-module'
  });
  
  // Set up event handlers
  client.onConnected = (token) => {
    console.log(`Connected! Received token: ${token}`);
  };
  
  client.onDisconnected = (reason) => {
    console.log(`Disconnected: ${reason}`);
  };
  
  client.onError = (error) => {
    console.log(`Error: ${error}`);
  };
  
  await client.connect();
  
  // Keep the connection alive for some time
  await new Promise(resolve => setTimeout(resolve, 3600000));
  
  await client.disconnect();
}

// Option 2: Using event emitter API
async function mainWithEvents() {
  const client = new GluesyncClient({
    host: 'localhost',
    port: 1717,
    licenseFilePath: '/path/to/gs-license.dat',
    moduleTag: 'my-module'
  });
  
  // Set up event listeners
  client.on('connected', (token) => {
    console.log(`Connected! Received token: ${token}`);
  });
  
  client.on('disconnected', (reason) => {
    console.log(`Disconnected: ${reason}`);
  });
  
  client.on('error', (error) => {
    console.log(`Error: ${error}`);
  });
  
  await client.connect();
  
  // Keep the connection alive for some time
  await new Promise(resolve => setTimeout(resolve, 3600000));
  
  await client.disconnect();
}

main().catch(console.error);
```

## API Reference

### `GluesyncClient`

The main class for interacting with Gluesync CoreHub.

#### Constructor Options

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| host | string \| null | No | null | The hostname or IP of the CoreHub. If null, autodiscovery will be used |
| port | number | No | 1717 | The port number for the CoreHub WebSocket |
| licenseFilePath | string | No | "gs-license.dat" | Path to the gs-license.dat file |
| moduleTag | string | No | "nodejs-module" | The module identifier tag |
| ssl | boolean | No | false | Whether to use SSL/TLS |
| keystorePath | string | No | null | Path to JKS keystore file (required if ssl=true) |
| keystorePassword | string | No | null | Password for the JKS keystore |
| pingInterval | number | No | 1000 | Interval in milliseconds between ping messages |
| timeout | number | No | 10000 | Connection timeout in milliseconds |
| discoveryStartPort | number | No | 1717 | The base port number for UDP discovery |
| discoveryPortRange | number | No | 10 | Number of ports to scan for UDP discovery |

#### Methods

- **`connect()`**: Establishes a WebSocket connection to the CoreHub
- **`disconnect()`**: Closes the WebSocket connection

#### Properties

- **`token`**: The JWT token received from CoreHub
- **`connectionStatus`**: Current status of the connection
- **`isConnected`**: Returns true if connected, false otherwise

#### Event Handlers

- **`onConnected(token)`**: Called when connection is successfully established
- **`onDisconnected(reason)`**: Called when connection is closed
- **`onError(error)`**: Called when an error occurs

#### Events (EventEmitter API)

- **`connected`**: Emitted when connection is successfully established
- **`disconnected`**: Emitted when connection is closed
- **`error`**: Emitted when an error occurs

## License

Gluesync Node.js SDK is dual-licensed under the following licenses:

1. GNU General Public License (GPL) Version 3
   You may use, modify, and distribute this software under the terms of the GPL v3.
   See the LICENSE-GPL file or <http://www.gnu.org/licenses/gpl-3.0.html> for details.
   This option is available at no cost, but any derivative works must also be licensed under GPL v3.

2. MOLO17 Commercial License
   Alternatively, you may use this software under the MOLO17 Commercial License,
   which includes a warranty and permits proprietary use. Contact MOLO17 at info@molo17.com
   for licensing terms and conditions.

You must choose one of these licenses to use this software. Using this software implies
acceptance of one of these licenses.

Copyright (C) 2025 MOLO17. All rights reserved.
