/**
 * This file is part of Gluesync Container Mate.
 *
 * Gluesync Container Mate is dual-licensed under the following licenses:
 *
 * 1. GNU General Public License (GPL) Version 3
 *    You may use, modify, and distribute this software under the terms of the GPL v3.
 *    This option is available at no cost, but any derivative works must also be licensed under GPL v3.
 *
 * 2. MOLO17 Commercial License
 *    Alternatively, you may use this software under the MOLO17 Commercial License,
 *    which includes a warranty and permits proprietary use. Contact MOLO17 at info@molo17.com
 *    for licensing terms and conditions.
 *
 * Copyright (C) 2025 MOLO17. All rights reserved.
 */

import fastify from 'fastify';
import {
  gluesyncSdkClient,
  settings,
  setupHttpsRedirect,
  getSSLConfig,
  cleanupSSLFiles,
} from './index';

/**
 * Initialize and run the Gluesync SDK standalone server
 * This is used when running the SDK as a standalone application
 */
async function main() {
  try {
    console.log('Initializing Gluesync SDK...');

    // Create the server with appropriate options
    const serverOptions: any = {
      logger: settings.debug
        ? {
            level: 'debug',
            transport: {
              target: 'pino-pretty',
            },
          }
        : true,
    };

    // Add HTTPS config if SSL is enabled
    if (settings.useSSL) {
      const sslConfig = getSSLConfig();
      if (sslConfig) {
        serverOptions.https = sslConfig;
      }
    }

    const app = fastify(serverOptions);

    // Add HTTP to HTTPS redirect if SSL is enabled
    if (settings.useSSL) {
      setupHttpsRedirect(app);
    }

    // Register routes
    app.get('/health', async () => {
      return {
        status: 'ok',
        sdkInitialized: gluesyncSdkClient.isInitialized,
        coreHubUrl: gluesyncSdkClient.coreHubUrl,
      };
    });

    // Initialize the Gluesync SDK client
    await gluesyncSdkClient.initialize();

    // Start the server
    await app.listen({
      host: settings.host,
      port: settings.port,
    });

    console.log(
      `Server is running on ${settings.useSSL ? 'https' : 'http'}://${settings.host}:${settings.port}`,
    );

    // Handle process termination
    const shutdown = async () => {
      console.log('Shutting down server...');
      await app.close();
      await gluesyncSdkClient.shutdown();
      cleanupSSLFiles();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('Failed to start the server:', error);
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main();
}

export default main;
