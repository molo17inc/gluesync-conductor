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

import { getGluesyncSdkClient } from '../gluesyncSdkClient';
// If you need settings, import from the SDK package as before
import { settings } from '../../../gluesync-sdk/src';

// Define Node.js process variable
declare const process: {
  env: {
    [key: string]: string | undefined;
  };
};

// Define types for Fastify
interface FastifyInstance {
  log: {
    info: (message: string) => void;
    error: (message: string) => void;
    warn: (message: string) => void;
  };
  decorate: (name: string, value: any) => void;
  addHook: (name: string, handler: any) => void;
}

/**
 * Gluesync SDK plugin for Fastify
 *
 * This plugin provides integration with the Gluesync SDK for connecting to CoreHub
 * with automatic initialization, retry logic, and proper error handling.
 */
async function gluesyncPlugin(
  fastify: FastifyInstance,
  options: any,
  done: (error?: Error) => void,
): Promise<void> {
  // Get the singleton instance of the SDK client
  const sdkClient = getGluesyncSdkClient();

  // Set the module tag from environment variable or use default
  const moduleTag = process.env.GLUESYNC_MODULE_TAG || 'gluesync-conductor';
  settings.moduleTag = moduleTag;
  fastify.log.info(`Using module tag: ${settings.moduleTag}`);

  // Log license file path if set
  const licenseFile =
    process.env.GLUESYNC_LICENSE_FILE || '/opt/gluesync/data/gs-license.dat';
  fastify.log.info(`License file path: ${licenseFile}`);

  // Log security config path if set
  const securityConfig =
    process.env.GLUESYNC_SECURITY_CONFIG ||
    '/opt/gluesync/data/security-config.json';
  fastify.log.info(`Security config path: ${securityConfig}`);

  // Add the SDK client to the fastify instance (even before initialization)
  fastify.decorate('gluesyncSdk', sdkClient);

  // Add a hook to close the connection when the server is shutting down
  fastify.addHook('onClose', async (instance: any, hookDone: any) => {
    fastify.log.info('Closing Gluesync SDK client connection');
    try {
      await sdkClient.shutdown();
      fastify.log.info('Gluesync SDK client connection closed successfully');
      hookDone();
    } catch (error) {
      fastify.log.error(
        `Error closing Gluesync SDK client connection: ${error instanceof Error ? error.message : String(error)}`,
      );
      hookDone();
    }
  });

  // Don't block server startup - initialize in the background
  fastify.log.info('Initializing Gluesync SDK client in the background...');
  sdkClient
    .initialize()
    .then(() => {
      fastify.log.info('Gluesync SDK client initialized successfully');
    })
    .catch(error => {
      fastify.log.error(
        `Failed to initialize Gluesync SDK client: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  // Allow server to start without waiting for CoreHub discovery
  done();
}

export default function (
  fastify: FastifyInstance,
  options: any,
  done: (error?: Error) => void,
): void {
  gluesyncPlugin(fastify, options, done).catch(error => {
    console.error('Unhandled error in gluesync plugin:', error);
    done(error instanceof Error ? error : new Error(String(error)));
  });
}
