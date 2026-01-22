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

import { GluesyncClient } from 'gluesync-sdk';
import { Logger } from 'pino';
import settings, { updateCoreHubUrl } from './config';

/**
 * Singleton class for managing the Gluesync SDK client connection
 */
export class GluesyncSDKClient {
  private static _instance: GluesyncSDKClient;

  private _token: string | null = null;

  private _client: GluesyncClient | null = null;

  private _isInitialized = false;

  private readonly _reconnectTimer: NodeJS.Timeout | null = null;

  private _logger: Logger | Console = console;

  /**
   * Constructor - private to enforce singleton pattern
   * @param logger Optional logger instance (defaults to console)
   */
  private constructor(logger?: Logger) {
    if (logger) {
      this._logger = logger;
    }
  }

  /**
   * Helper method to log messages compatible with both Console and Pino Logger
   * @param level Log level ('info', 'error', 'warn')
   * @param message Log message
   * @param meta Optional metadata object
   */
  private readonly _log = (
    level: 'info' | 'error' | 'warn',
    message: string,
    meta?: any,
  ): void => {
    if (this._isPinoLogger(this._logger)) {
      (this._logger as any)[level](meta || {}, message);
    } else if (meta) {
      (this._logger as any)[level](message, meta);
    } else {
      (this._logger as any)[level](message);
    }
  };

  /**
   * Check if the logger is a Pino Logger instance
   */
  private readonly _isPinoLogger = (
    logger: Logger | Console,
  ): logger is Logger =>
    typeof logger === 'object' && 'info' in logger && 'child' in logger;

  /**
   * Get the singleton instance with optional logger
   * @param logger Optional logger instance
   */
  public static getInstance(logger?: Logger): GluesyncSDKClient {
    if (!GluesyncSDKClient._instance) {
      GluesyncSDKClient._instance = new GluesyncSDKClient(logger);
    } else if (logger && GluesyncSDKClient._instance._logger === console) {
      // Update logger if instance exists but is using default console logger
      GluesyncSDKClient._instance._logger = logger;
    }
    return GluesyncSDKClient._instance;
  }

  /**
   * Get the current JWT token
   */
  public get token(): string | null {
    return this._token;
  }

  /**
   * Get the Gluesync client instance
   */
  public get client(): GluesyncClient | null {
    return this._client;
  }

  /**
   * Check if the client is initialized
   */
  public get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Get the CoreHub URL after discovery
   */
  public get coreHubUrl(): string | null {
    if (!this._client || !this._isInitialized) {
      return null;
    }

    // Access properties safely using type assertion and any type
    // This is necessary because the GluesyncClient class has private properties
    const client = this._client as any;
    const { host } = client;
    const { port } = client;
    const { useSSL } = client;

    return this._buildCoreHubUrl(host, port, useSSL);
  }

  /**
   * Build a proper CoreHub URL with the given host, port and SSL setting
   * @param host The host name or IP address
   * @param port The port number
   * @param useSSL Whether to use HTTPS or HTTP
   * @returns The formatted CoreHub URL
   */
  private readonly _buildCoreHubUrl = (
    host: string,
    port: number,
    useSSL = false,
  ): string | null => {
    if (!host) {
      return null;
    }

    // Use default port if none provided
    if (port === undefined || port === null) {
      port = 1717;
    }

    const scheme = useSSL ? 'https' : 'http';
    return `${scheme}://${host}:${port}`;
  };

  /**
   * Initialize the Gluesync client with indefinite retries and exponential backoff
   * The method will retry indefinitely with exponential backoff starting at 1 second,
   * doubling each time up to 30 seconds, then resetting back to 1 second.
   */
  public initialize = async (): Promise<void> => {
    if (this._isInitialized) {
      this._log('info', 'Gluesync SDK client already initialized');
      return;
    }

    // Parse host and port from GLUESYNC_HOST if provided
    let host: string | null = null;
    let port: number | null = null;
    let useSSL = false;

    const gluesyncHost =
      process.env.GLUESYNC_HOST || process.env.CORE_HUB_ADDRESS;

    if (gluesyncHost) {
      const rawHost = gluesyncHost.trim();

      // If it already looks like a URL, keep as-is.
      // Otherwise, use _buildCoreHubUrl to construct a default URL.
      const normalized =
        rawHost.startsWith('http://') || rawHost.startsWith('https://')
          ? rawHost
          : this._buildCoreHubUrl(rawHost, 1717, false);

      if (!normalized) {
        this._log('error', `Invalid GLUESYNC_HOST: ${rawHost} - empty host`);
      } else {
        try {
          const url = new URL(normalized);
          host = url.hostname;
          port = url.port ? parseInt(url.port, 10) : 1717;
          useSSL = url.protocol === 'https:';

          this._log(
            'info',
            `Using provided CoreHub host: ${host} at port: ${port} (raw=${rawHost}, normalized=${normalized})`,
          );
        } catch (error: unknown) {
          if (error instanceof Error) {
            this._log(
              'error',
              `Invalid GLUESYNC_HOST: ${rawHost} - ${error.message}`,
              { stack: error.stack },
            );
          } else {
            this._log(
              'error',
              `Invalid GLUESYNC_HOST: ${rawHost} - Unknown error`,
              { error },
            );
          }
        }
      }
    } else {
      this._log(
        'info',
        'No CoreHub URL provided, will use UDP discovery instead',
      );
    }

    // Get license file path from environment
    const licenseFilePath =
      process.env.GLUESYNC_LICENSE_FILE || '/opt/gluesync/data/gs-license.dat';

    // SSL configuration
    if (process.env.SSL_ENABLED?.toLowerCase() === 'true') {
      useSSL = true;
    }

    // Security configuration
    const securityConfig =
      process.env.GLUESYNC_SECURITY_CONFIG ||
      '/opt/gluesync/data/security-config.json';

    // Create the client
    try {
      this._log('info', 'Creating Gluesync SDK client...');
      this._log('info', `Module tag: ${settings.moduleTag}`);
      this._log('info', `License file: ${licenseFilePath}`);
      this._log('info', `Security config: ${securityConfig}`);
      this._log('info', `SSL enabled: ${useSSL}`);

      this._client = new GluesyncClient({
        host: host || undefined, // undefined will trigger UDP discovery
        port: port || 1717, // Use default port 1717 if null
        licenseFilePath,
        moduleTag: settings.moduleTag,
        ssl: useSSL, // Property name is 'ssl' in the actual implementation
        securityConfig: securityConfig || undefined,
        verifySsl: process.env.SSL_SKIP_VERIFY?.toLowerCase() !== 'true', // Skip SSL verification if requested
      } as any); // Use type assertion to bypass type checking

      // Set up event handlers
      this._client.on('connected', this._onConnected);
      this._client.on('disconnected', this._onDisconnected);
      this._client.on('error', this._onError);
      console.log(
        'Security config file not found, using environment variables',
      );

      // Connect to CoreHub with indefinite retry logic and exponential backoff
      let retryCount = 0;
      let backoffDelay = 1; // Start with 1 second delay
      const maxBackoff = 30; // Maximum backoff of 30 seconds
      let cycleCount = 0; // Count full cycles of backoff

      while (true) {
        // Retry indefinitely
        try {
          if (host && port) {
            this._log('info', `Connecting to CoreHub at ${host}:${port}...`);
            await this._client.connect();
            break; // Connection successful
          } else {
            // UDP discovery mode
            if (retryCount > 0) {
              this._log(
                'info',
                `Retry ${retryCount} (cycle ${cycleCount}) for UDP discovery...`,
              );
            } else {
              this._log('info', 'Starting UDP discovery to find CoreHub...');
            }

            await this._client.connect();

            // After connect, check if we have a host (discovery worked)
            const client = this._client as any;
            if (client.host) {
              this._log(
                'info',
                `UDP discovery successful! Found CoreHub at ${client.host}:${client.port}`,
              );
              // Update the discovered host/port for future use
              if (host) {
                // Only build URL if host is not null
                const coreHubUrl = this._buildCoreHubUrl(
                  host,
                  port || 1717,
                  useSSL,
                );
                if (coreHubUrl) {
                  updateCoreHubUrl(coreHubUrl);
                  this._log('info', `Updated CoreHub URL to ${coreHubUrl}`);
                }
              }
              break; // Connection successful
            } else {
              this._log(
                'warn',
                'UDP discovery did not find CoreHub, will retry',
              );
              // Don't throw an error, just let the retry loop continue
              throw new Error(
                'UDP discovery did not find CoreHub, continuing retry',
              );
            }
          }
        } catch (error) {
          if (host && port) {
            // If we have a specific host/port and can't connect, don't retry
            this._log(
              'error',
              `Failed to connect to CoreHub at ${host}:${port}: ${error}`,
            );
            throw error;
          } else {
            // For UDP discovery, retry with exponential backoff
            retryCount++;

            // Check if this is a port binding error (EADDRINUSE)
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            const isPortBindingError = errorMessage.includes('EADDRINUSE');

            if (isPortBindingError) {
              this._log('warn', `Port binding error detected: ${errorMessage}`);

              // Recreate the client with different discovery port range
              try {
                const randomPortOffset =
                  Math.floor(Math.random() * 1000) + 2000; // Use higher port range
                this._log(
                  'info',
                  `Recreating client with discovery port range starting at ${randomPortOffset}`,
                );

                // Create new client with different discovery port
                this._client = new GluesyncClient({
                  moduleTag: settings.moduleTag,
                  licenseFilePath:
                    settings.licenseFile || '/opt/gluesync/data/gs-license.dat',
                  securityConfig: securityConfig || undefined,
                  ssl: useSSL,
                  verifySsl:
                    process.env.SSL_SKIP_VERIFY?.toLowerCase() !== 'true',
                  discoveryPortRange: randomPortOffset,
                } as any);

                // Set up event handlers
                this._client.on('connected', this._onConnected);
                this._client.on('disconnected', this._onDisconnected);
                this._client.on('error', this._onError);

                this._log(
                  'info',
                  'Client recreated with new discovery port range',
                );

                // Use shorter backoff for port binding errors
                backoffDelay = 1;
              } catch (recreateError) {
                this._log(
                  'error',
                  `Failed to recreate client: ${recreateError}`,
                );
              }
            } else {
              this._log(
                'warn',
                `UDP discovery attempt ${retryCount} failed: ${errorMessage}`,
              );

              // Calculate backoff with exponential increase
              this._log(
                'info',
                `Waiting ${backoffDelay} seconds before next retry...`,
              );
              await new Promise(resolve =>
                setTimeout(resolve, backoffDelay * 1000),
              );

              // Double the backoff for next time, up to the maximum
              backoffDelay = Math.min(backoffDelay * 2, maxBackoff);

              // If we've reached max backoff, reset on the next failure
              if (backoffDelay >= maxBackoff) {
                backoffDelay = 1; // Reset to 1 second
                cycleCount++; // Increment cycle count
                this._log(
                  'info',
                  `Completed backoff cycle ${cycleCount}, resetting delay to 1 second`,
                );
              }
            }
          }
        }
      }

      this._isInitialized = true;
      this._log('info', 'Gluesync SDK client initialized successfully');
    } catch (error) {
      this._log('error', `Failed to initialize Gluesync SDK client: ${error}`);
      throw error;
    }
  };

  /**
   * Shutdown the Gluesync client
   */
  public shutdown = async (): Promise<void> => {
    if (this._client && (this._client as any).isConnected) {
      this._log('info', 'Disconnecting from CoreHub...');
      await this._client.disconnect();
      this._isInitialized = false;
      this._token = null;
    }
  };

  /**
   * Handle the connected event
   * @param token The JWT token received from the server
   */
  private readonly _onConnected = (token: string): void => {
    this._token = token;
    this._log('info', 'Connected to CoreHub successfully! Token received.');
  };

  /**
   * Handle the disconnected event
   * @param reason The reason for disconnection
   */
  private readonly _onDisconnected = (reason: string): void => {
    this._token = null;
    this._isInitialized = false;
    this._log('info', `Disconnected from CoreHub: ${reason}`);
  };

  /**
   * Handle the error event
   * @param error The exception that occurred
   */
  private readonly _onError = (error: Error): void => {
    console.error(`Error in connection: ${error.message}`);
  };
}

// Create a global instance for easy import
export const gluesyncSdkClient = GluesyncSDKClient.getInstance();
