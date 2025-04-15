/**
 * This file is part of Gluesync Scheduler Module.
 *
 * Gluesync Scheduler Module is dual-licensed under the following licenses:
 *
 * 1. GNU General Public License (GPL) Version 3
 *    You may use, modify, and distribute this software under the terms of the GPL v3.
 *    See the LICENSE-GPL file or <http://www.gnu.org/licenses/gpl-3.0.html> for details.
 *    This option is available at no cost, but any derivative works must also be licensed under GPL v3.
 *
 * 2. MOLO17 Commercial License
 *    Alternatively, you may use this software under the MOLO17 Commercial License,
 *    which includes a warranty and permits proprietary use. Contact MOLO17 at info@molo17.com
 *    for licensing terms and conditions.
 *
 * You must choose one of these licenses to use this software. Using this software implies
 * acceptance of one of these licenses. See the accompanying LICENSE files or contact
 * MOLO17 for more information.
 *
 * Copyright (C) 2025 MOLO17. All rights reserved.
 */

import * as fs from 'fs-extra';
import * as tls from 'tls';
import { EventEmitter } from 'events';
import debug from 'debug';

import { WebSocketConnection, CallbackFunction } from './connection';
import { createSslContextFromJks } from './utils';
import { getCorehubAddress } from './discovery';
import {
  GluesyncError,
  GluesyncConnectionError,
  // GluesyncAuthenticationError,
  GluesyncLicenseError,
  GluesyncSSLError,
} from './exceptions';

// Set up debug logger
const log = debug('gluesync:client');

/**
 * Main client for interacting with Gluesync CoreHub services.
 * Manages the connection, authentication, and WebSocket communication with the CoreHub.
 */
export class GluesyncClient extends EventEmitter {
  private host: string | null;
  private port: number;
  private moduleTag: string;
  private useSSL: boolean;
  private verifySsl: boolean;
  private pingInterval: number;
  private timeout: number;
  private discoveryStartPort: number;
  private discoveryPortRange: number;

  private licenseFilePath: string;
  private licenseContent: string | null = null;

  private sslOptions: tls.ConnectionOptions | null = null;
  private connection: WebSocketConnection | null = null;
  private _token: string | null = null;

  /**
   * Initialize the Gluesync client.
   *
   * @param options - Client configuration options
   * @param options.host - Hostname or IP address of the CoreHub (null for autodiscovery)
   * @param options.port - Port number for the CoreHub WebSocket
   * @param options.licenseFilePath - Path to the gs-license.dat file
   * @param options.moduleTag - Name/tag for this module
   * @param options.ssl - Whether to use SSL/TLS for the connection
   * @param options.keystorePath - Path to the JKS keystore file (required if ssl=true)
   * @param options.keystorePassword - Password for the JKS keystore (required if ssl=true)
   * @param options.pingInterval - Interval in milliseconds between ping messages
   * @param options.timeout - Connection timeout in milliseconds
   * @param options.discoveryStartPort - Base port for UDP discovery
   * @param options.discoveryPortRange - Number of ports to scan for UDP discovery
   */
  constructor({
    host = null,
    port = 1717,
    licenseFilePath = 'gs-license.dat',
    moduleTag = 'nodejs-module',
    ssl = false,
    verifySsl = true,
    keystorePath = null,
    keystorePassword = null,
    pingInterval = 1000,
    timeout = 10000,
    discoveryStartPort = 1717,
    discoveryPortRange = 10,
  }: {
    host?: string | null;
    port?: number;
    licenseFilePath?: string;
    moduleTag?: string;
    ssl?: boolean;
    verifySsl?: boolean;
    keystorePath?: string | null;
    keystorePassword?: string | null;
    pingInterval?: number;
    timeout?: number;
    discoveryStartPort?: number;
    discoveryPortRange?: number;
  } = {}) {
    super();

    this.host = host;
    this.port = port;
    this.moduleTag = moduleTag;
    this.useSSL = ssl;
    this.verifySsl = verifySsl;
    this.pingInterval = pingInterval;
    this.timeout = timeout;
    this.discoveryStartPort = discoveryStartPort;
    this.discoveryPortRange = discoveryPortRange;
    this.licenseFilePath = licenseFilePath;

    // Event handlers
    this._onConnected = this._onConnected.bind(this);
    this._onDisconnected = this._onDisconnected.bind(this);
    this._onError = this._onError.bind(this);

    // SSL context setup
    if (this.useSSL) {
      if (!keystorePath || !keystorePassword) {
        throw new GluesyncSSLError(
          'Keystore path and password are required for SSL connections',
        );
      }

      // We'll initialize the SSL context when connecting to avoid
      // blocking the constructor with async operations

      log('SSL will be used for connection');
    }

    log('GluesyncClient initialized for %s:%d', host || 'autodiscovery', port);
  }

  /**
   * Get the JWT token received from CoreHub after authentication.
   *
   * @returns The JWT token as a string, or null if not authenticated
   */
  public get token(): string | null {
    if (this.connection && this.connection.token) {
      return this.connection.token;
    }
    return this._token;
  }

  /**
   * Get the current connection status.
   *
   * @returns String describing the connection status
   */
  public get connectionStatus(): string {
    if (!this.connection) {
      return 'Not initialized';
    }

    if (this.connection.isConnected) {
      return 'Connected';
    }

    return 'Disconnected';
  }

  /**
   * Check if the client is currently connected to CoreHub.
   *
   * @returns True if connected, False otherwise
   */
  public get isConnected(): boolean {
    return (
      this._connected &&
      this.connection !== null &&
      this.connection.isConnected === true
    );
  }

  /**
   * Set the connected state
   */
  private _connected: boolean = false;

  /**
   * Event handler for connected events.
   * Set this to receive notifications when the client connects.
   */
  public onConnected: CallbackFunction<string> | null = null;

  /**
   * Event handler for disconnected events.
   * Set this to receive notifications when the client disconnects.
   */
  public onDisconnected: CallbackFunction<string> | null = null;

  /**
   * Event handler for error events.
   * Set this to receive notifications when an error occurs.
   */
  public onError: CallbackFunction<Error> | null = null;

  /**
   * Generate the HTTP headers for the WebSocket connection.
   *
   * @returns Dictionary of HTTP headers
   * @throws GluesyncLicenseError if the license file cannot be read
   */
  public getConnectionHeaders(): Record<string, string> {
    return {
      'Module-License': this.getLicenseContent(),
      'Module-Tag': this.moduleTag,
    };
  }

  /**
   * Connect to the CoreHub and perform the handshake authentication.
   *
   * If a host was not explicitly provided in constructor, this method will
   * attempt to discover the CoreHub on the local network before connecting.
   *
   * @returns Promise resolving to the JWT token received from the server
   * @throws GluesyncConnectionError if the connection fails
   * @throws GluesyncAuthenticationError if authentication fails
   */
  public async connect(): Promise<string> {
    if (this.isConnected) {
      log('Already connected to CoreHub');
      return this.token!;
    }

    // Reset connection state
    this._connected = false;

    try {
      // Use autodiscovery if host is not provided
      let host = this.host;
      if (host === null) {
        try {
          log('No host provided, using UDP autodiscovery to find CoreHub...');
          host = await getCorehubAddress(
            'CORE_HUB_ADDRESS',
            this.discoveryStartPort,
            this.discoveryPortRange,
            this.timeout,
            this.verifySsl,
          );

          // Save the discovered host
          this.host = host;
          log('CoreHub discovered at %s', host);
        } catch (error) {
          log('Failed to discover CoreHub: %s', error);
          throw new GluesyncConnectionError(
            `Failed to discover CoreHub: ${error}`,
          );
        }
      }

      // Set up SSL options if needed
      if (this.useSSL && !this.sslOptions) {
        try {
          // Get keystore path and password from constructor parameters or environment variables
          const keystorePath = process.env.KEYSTORE_PATH || '';
          const keystorePassword = process.env.KEYSTORE_PASSWORD || '';

          this.sslOptions = await createSslContextFromJks(
            keystorePath,
            keystorePassword,
          );
          log('SSL context created successfully');
        } catch (error) {
          log('Failed to create SSL context: %s', error);
          throw new GluesyncSSLError(`Failed to create SSL context: ${error}`);
        }
      }

      // Create the connection
      this.connection = new WebSocketConnection(
        host,
        this.port,
        this.getConnectionHeaders(),
        this.sslOptions,
        this.pingInterval,
        this.timeout,
        this.verifySsl,
      );

      // Set up event handlers
      this.connection.onConnected = this._onConnected;
      this.connection.onDisconnected = this._onDisconnected;
      this.connection.onError = this._onError;

      // Connect to the server
      const token = await this.connection.connect();
      this._token = token;
      this._connected = true;

      log('Connected to CoreHub at %s:%d', host, this.port);
      return token;
    } catch (error) {
      log('Connection failed: %s', error);

      // Forward the appropriate error type
      if (error instanceof GluesyncError) {
        throw error;
      }

      throw new GluesyncConnectionError(`Failed to connect: ${error}`);
    }
  }

  /**
   * Disconnect from the CoreHub.
   *
   * @throws GluesyncConnectionError if an error occurs during disconnection
   */
  public async disconnect(): Promise<void> {
    if (!this.isConnected) {
      log('Not connected to CoreHub');
      return;
    }

    // Reset connection state
    this._connected = false;

    try {
      await this.connection!.disconnect();
      log('Disconnected from CoreHub');
    } catch (error) {
      log('Error during disconnection: %s', error);
      throw new GluesyncConnectionError(`Error during disconnection: ${error}`);
    }
  }

  /**
   * Load and get the license content from the file.
   *
   * @returns The license content as a string
   * @throws GluesyncLicenseError if the license file cannot be read
   */
  private getLicenseContent(): string {
    if (this.licenseContent === null) {
      try {
        if (!fs.existsSync(this.licenseFilePath)) {
          throw new GluesyncLicenseError(
            `License file not found: ${this.licenseFilePath}`,
          );
        }

        this.licenseContent = fs
          .readFileSync(this.licenseFilePath, 'utf8')
          .trim();
      } catch (error) {
        if (error instanceof GluesyncLicenseError) {
          throw error;
        }
        throw new GluesyncLicenseError(`Failed to read license file: ${error}`);
      }
    }

    return this.licenseContent;
  }

  /**
   * Handle the connected event.
   *
   * @param token - The JWT token received from the server
   */
  private async _onConnected(token: string): Promise<void> {
    log('Connected to CoreHub successfully');
    this._token = token;

    // Emit event
    this.emit('connected', token);

    // Call callback if defined
    if (this.onConnected) {
      try {
        const result = this.onConnected(token);
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        log('Error in onConnected callback: %s', error);
      }
    }
  }

  /**
   * Handle the disconnected event.
   *
   * @param reason - The reason for disconnection
   */
  private async _onDisconnected(reason: string): Promise<void> {
    log('Disconnected from CoreHub: %s', reason);

    // Emit event
    this.emit('disconnected', reason);

    // Call callback if defined
    if (this.onDisconnected) {
      try {
        const result = this.onDisconnected(reason);
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        log('Error in onDisconnected callback: %s', error);
      }
    }
  }

  /**
   * Handle the error event.
   *
   * @param error - The exception that occurred
   */
  private async _onError(error: Error): Promise<void> {
    log('Error in connection: %s', error.message);

    // Emit event
    this.emit('error', error);

    // Call callback if defined
    if (this.onError) {
      try {
        const result = this.onError(error);
        if (result instanceof Promise) {
          await result;
        }
      } catch (callbackError) {
        log('Error in onError callback: %s', callbackError);
      }
    }
  }
}
