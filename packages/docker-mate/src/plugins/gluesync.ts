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

import { FastifyPluginAsync } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { GluesyncSDKClient } from 'gluesync-sdk';

/**
 * Attempts to connect to CoreHub with exponential backoff
 * @param fastify The Fastify instance for logging
 * @param sdkClient The Gluesync SDK client instance
 * @param attempt The current attempt number
 * @param maxAttempts Maximum number of attempts (0 for unlimited)
 * @param initialDelay Initial delay in milliseconds
 * @param maxDelay Maximum delay in milliseconds
 */
async function connectWithBackoff(
  fastify: any,
  sdkClient: any,
  attempt = 1,
  maxAttempts = 0, // 0 means unlimited attempts
  initialDelay = 1000,
  maxDelay = 30000
): Promise<void> {
  // If we've reached max attempts (and it's not unlimited), give up
  if (maxAttempts > 0 && attempt > maxAttempts) {
    fastify.log.error(`Failed to connect to CoreHub after ${maxAttempts} attempts`);
    return;
  }
  
  // Calculate delay with exponential backoff and jitter
  const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
  const jitter = Math.random() * 0.3 * delay; // Add up to 30% jitter
  const actualDelay = Math.floor(delay + jitter);
  
  try {
    // Only try to initialize if not already initialized
    if (!sdkClient.isInitialized) {
      fastify.log.info(`Attempting to connect to CoreHub (attempt ${attempt})...`);
      await sdkClient.initialize();
      
      if (sdkClient.isInitialized) {
        fastify.log.info('Gluesync SDK client initialized successfully');
        
        if (sdkClient.coreHubUrl) {
          fastify.log.info(`Connected to CoreHub at ${sdkClient.coreHubUrl}`);
        } else {
          fastify.log.warn('Connected to CoreHub but URL is not available');
        }
        return; // Successfully connected, exit the retry loop
      }
    } else {
      // Already initialized, no need to retry
      return;
    }
  } catch (error) {
    fastify.log.warn(`Connection attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // Schedule next attempt with backoff
  fastify.log.info(`Will retry in ${Math.floor(actualDelay / 1000)} seconds (attempt ${attempt + 1})`);
  setTimeout(() => {
    connectWithBackoff(fastify, sdkClient, attempt + 1, maxAttempts, initialDelay, maxDelay);
  }, actualDelay);
}

/**
 * Fastify plugin to initialize the Gluesync SDK client
 */
const gluesyncPlugin: FastifyPluginAsync = async (fastify) => {
  // Create a wrapper for the SDK client that handles initialization errors gracefully
  const initializeSDK = async () => {
    try {
      const sdkClient = GluesyncSDKClient.getInstance();
      await sdkClient.initialize();
      return { success: true, client: sdkClient };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : String(error),
        client: GluesyncSDKClient.getInstance() // Return the instance even if initialization failed
      };
    }
  };
  
  // Start the connection process but don't wait for it to complete
  // This allows the server to start up immediately
  try {
    // Create a promise that times out after 2 seconds for the initial attempt
    const initPromise = initializeSDK();
    const timeoutPromise = new Promise<any>((_, reject) => {
      setTimeout(() => {
        reject(new Error('Initial Gluesync SDK initialization timed out'));
      }, 2000);
    });
    
    // Race the initialization against the timeout
    const result = await Promise.race([initPromise, timeoutPromise])
      .catch(error => {
        fastify.log.warn(`Initial connection attempt timed out: ${error instanceof Error ? error.message : String(error)}`);
        fastify.log.info('Continuing server startup without waiting for CoreHub discovery');
        return { success: false, error: 'Timeout', client: GluesyncSDKClient.getInstance() };
      });
    
    // Store the client instance regardless of connection success
    const sdkClient = result.client;
    
    if (result.success) {
      // Successfully connected on first try
      fastify.log.info('Gluesync SDK client initialized successfully');
      
      if (sdkClient.coreHubUrl) {
        fastify.log.info(`Connected to CoreHub at ${sdkClient.coreHubUrl}`);
      }
    } else {
      // Failed to connect on first try, start background retry process
      fastify.log.warn(`Initial connection failed: ${result.error}`);
      fastify.log.info('Will attempt to connect in the background');
      
      // Start the background connection process with exponential backoff
      // We use setImmediate to ensure this runs after the server has started
      setImmediate(() => {
        connectWithBackoff(fastify, sdkClient, 1, 0); // Unlimited retries
      });
    }
    
    // Add the SDK client to the fastify instance
    fastify.decorate('gluesyncSdk', sdkClient);
  } catch (error) {
    fastify.log.error(`Failed to initialize Gluesync SDK client: ${error instanceof Error ? error.message : String(error)}`);
    
    // Even if the initial attempt fails, we still need to decorate the instance
    const sdkClient = GluesyncSDKClient.getInstance();
    fastify.decorate('gluesyncSdk', sdkClient);
    
    // Start the background connection process
    setImmediate(() => {
      connectWithBackoff(fastify, sdkClient, 1, 0); // Unlimited retries
    });
  }
  
  // Hook for server shutdown - already handled above
  
  // Add a hook to close the connection when the server is shutting down
  fastify.addHook('onClose', async () => {
    fastify.log.info('Closing Gluesync SDK client connection');
    // Add any cleanup code here if needed
  });
};

export default fastifyPlugin(gluesyncPlugin);
