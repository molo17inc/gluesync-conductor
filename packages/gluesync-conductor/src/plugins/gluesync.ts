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

// How long the registration waits for the first connection to CoreHub. Well
// under Fastify's default plugin timeout (10 s), which must stay untouched.
export const STARTUP_WAIT_MS = 5000;

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

  // Try before the server starts listening, but never block the registration on
  // CoreHub: the SDK keeps discovering it (UDP broadcasts arrive every 5 s plus
  // ~100 ms per port) and retrying with no upper bound, so initialize() can
  // outlast Fastify's plugin timeout (10 s) and the conductor used to die with
  // "Plugin did not start in time" until the restart policy got lucky. Wait a
  // few seconds so that a CoreHub that is up still answers before the first
  // request, then start anyway and let the attempt finish in the background.
  // If CoreHub is unreachable (restarting, being updated, down) or the attempt
  // fails, retry in the background as well: exiting made the conductor
  // crash-loop and unreachable for as long as CoreHub was down. Until it
  // connects, authenticated calls answer 503 "CoreHub unavailable".
  const logConnected = (): void => {
    fastify.log.info('Gluesync SDK client initialized successfully');
    fastify.log.info(`CoreHub URL: ${sdkClient.coreHubUrl ?? 'not set'}`);
    fastify.log.info(`SDK token present: ${sdkClient.token ? 'yes' : 'no'}`);
  };

  const retryCell = new Map<string, NodeJS.Timeout | boolean>([
    ['stopped', false],
  ]);
  const inFlightCell = new Map<'current', Promise<void>>();

  // At most one initialize() runs at a time: the startup attempt that outlives
  // the wait and a background retry must never overlap, because the SDK
  // client builds a new connection on every call.
  const attemptConnect = (): Promise<void> => {
    const running = inFlightCell.get('current');
    if (running) {
      return running;
    }
    const attempt: Promise<void> = (async () =>
      sdkClient.initialize())().finally(() => {
      if (inFlightCell.get('current') === attempt) {
        inFlightCell.delete('current');
      }
    });
    inFlightCell.set('current', attempt);
    return attempt;
  };

  const retryInBackground = (attempt: number): void => {
    const delayMs = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    const timer = setTimeout(async () => {
      if (retryCell.get('stopped')) {
        return;
      }
      try {
        await attemptConnect();
        if (retryCell.get('stopped')) {
          return;
        }
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

  fastify.addHook('onClose', (_instance: unknown, hookDone: () => void) => {
    retryCell.set('stopped', true);
    const timer = retryCell.get('timer');
    if (timer && typeof timer !== 'boolean') {
      clearTimeout(timer);
    }
    hookDone();
  });

  fastify.log.info('Initializing Gluesync SDK client...');
  const startupAttempt = attemptConnect();
  // Whenever the startup attempt ends, inside the wait or long after it
  // (also the only place its rejection is handled, so none goes unhandled).
  startupAttempt.then(
    () => {
      if (!retryCell.get('stopped')) {
        logConnected();
      }
    },
    error => {
      if (!retryCell.get('stopped')) {
        getLogger().warn(
          { error },
          'CoreHub not reachable at startup; starting anyway and retrying in the background',
        );
        retryInBackground(0);
      }
    },
  );

  const waitTimer = new Map<'current', NodeJS.Timeout>();
  const waitedOut = await Promise.race([
    startupAttempt.then(
      () => false,
      () => false,
    ),
    new Promise<boolean>(resolve => {
      waitTimer.set(
        'current',
        setTimeout(() => resolve(true), STARTUP_WAIT_MS),
      );
    }),
  ]);
  clearTimeout(waitTimer.get('current'));
  if (waitedOut) {
    fastify.log.warn(
      `CoreHub not connected after ${STARTUP_WAIT_MS} ms; starting anyway, the connection continues in the background`,
    );
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
