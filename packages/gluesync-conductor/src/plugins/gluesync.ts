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

// If you need settings, import from the SDK package as before
import { settings } from 'gluesync-sdk-client';

import { getGluesyncSdkClient } from '../gluesyncSdkClient';
import { getLogger } from '../utils/logger';

// Define Node.js process variable
declare const process: {
  env: {
    [key: string]: string | undefined;
  };
};

// Define types for Fastify
// eslint-disable-next-line functional/no-mixed-types
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
  fastify: Readonly<FastifyInstance>,
  options: any,
  done: (error?: Readonly<Error>) => void,
): Promise<void> {
  // Get the singleton instance of the SDK client
  const sdkClient = getGluesyncSdkClient(getLogger());

  // Set the module tag from environment variable or use default
  const moduleTag = process.env.GLUESYNC_MODULE_TAG || 'conductor';
  // eslint-disable-next-line functional/immutable-data
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

  // Try once before the server starts listening, as before. If CoreHub is not
  // reachable (restarting, being updated, down), keep the conductor up and
  // retry in the background: exiting here made the conductor crash-loop and
  // unreachable for as long as CoreHub was down. Until it connects,
  // authenticated calls answer 503 "CoreHub unavailable".
  const logConnected = (): void => {
    fastify.log.info('Gluesync SDK client initialized successfully');
    fastify.log.info(`CoreHub URL: ${sdkClient.coreHubUrl ?? 'not set'}`);
    fastify.log.info(`SDK token present: ${sdkClient.token ? 'yes' : 'no'}`);
  };

  const retryCell = new Map<string, NodeJS.Timeout | boolean>([
    ['stopped', false],
  ]);

  const retryInBackground = (attempt: number): void => {
    const delayMs = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    const timer = setTimeout(async () => {
      if (retryCell.get('stopped')) {
        return;
      }
      try {
        await sdkClient.initialize();
        fastify.log.info(
          `Connected to CoreHub after ${attempt + 1} background attempt(s)`,
        );
        logConnected();
      } catch (error) {
        getLogger().warn(
          {
            attempt: attempt + 1,
            nextRetryMs: Math.min(30000, 1000 * 2 ** Math.min(attempt + 1, 5)),
            error,
          },
          'CoreHub still unreachable; the conductor keeps running and retries',
        );
        retryInBackground(attempt + 1);
      }
    }, delayMs);
    retryCell.set('timer', timer);
  };

  fastify.addHook('onClose', async () => {
    retryCell.set('stopped', true);
    const timer = retryCell.get('timer');
    if (timer && typeof timer !== 'boolean') {
      clearTimeout(timer);
    }
  });

  fastify.log.info('Initializing Gluesync SDK client...');
  try {
    await sdkClient.initialize();
    logConnected();
  } catch (error) {
    getLogger().warn(
      { error },
      'CoreHub not reachable at startup; starting anyway and retrying in the background',
    );
    retryInBackground(0);
  }

  done();
}

// eslint-disable-next-line func-names
export default function (
  fastify: Readonly<FastifyInstance>,
  options: any,
  done: (error?: Readonly<Error>) => void,
): void {
  gluesyncPlugin(fastify, options, done).catch(error => {
    console.error('Unhandled error in gluesync plugin:', error);
    done(error instanceof Error ? error : new Error(String(error)));
  });
}
