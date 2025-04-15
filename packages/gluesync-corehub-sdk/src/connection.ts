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

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import * as tls from 'tls';
import debug from 'debug';
import {
  GluesyncAuthenticationError,
  GluesyncConnectionError,
  GluesyncClosedError,
  GluesyncHandshakeError,
  GluesyncTimeoutError,
} from './exceptions';
import { createTimeout, getErrorFromCloseReason } from './utils';

// Set up debug logger
const log = debug('gluesync:connection');

/**
 * Type definition for callback functions
 */
export type CallbackFunction<T = any> = (param: T) => void | Promise<void>;

/**
 * Manages WebSocket connection to Gluesync CoreHub.
 */
export class WebSocketConnection extends EventEmitter {
  private host: string;
  private port: number;
  private headers: Record<string, string>;
  private sslOptions: tls.ConnectionOptions | null;
  private pingInterval: number;
  private timeout: number;
  private verifySsl: boolean;

  private ws: WebSocket | null = null;
  private _token: string | null = null;
  private pingIntervalId: NodeJS.Timeout | null = null;
  private connected: boolean = false;

  // Event handlers
  public onConnected: CallbackFunction<string> | null = null;
  public onDisconnected: CallbackFunction<string> | null = null;
  public onError: CallbackFunction<Error> | null = null;

  /**
   * Initialize the WebSocket connection.
   *
   * @param host - Hostname or IP address of the CoreHub
   * @param port - Port number
   * @param headers - HTTP headers to send with the WebSocket handshake
   * @param sslOptions - SSL/TLS options for secure connections (optional)
   * @param pingInterval - Interval in milliseconds between ping messages
   * @param timeout - Connection timeout in milliseconds
   * @param verifySsl - Whether to verify SSL certificates (default: true)
   */
  constructor(
    host: string,
    port: number,
    headers: Record<string, string>,
    sslOptions: tls.ConnectionOptions | null = null,
    pingInterval: number = 1000,
    timeout: number = 10000,
    verifySsl: boolean = true,
  ) {
    super();
    this.host = host;
    this.port = port;
    this.headers = headers;
    this.sslOptions = sslOptions;
    this.pingInterval = pingInterval;
    this.timeout = timeout;
    this.verifySsl = verifySsl;

    log('WebSocketConnection initialized for %s:%d', host, port);
  }

  /**
   * Check if the connection is established.
   *
   * @returns True if connected, False otherwise
   */
  public get isConnected(): boolean {
    return (
      this.connected &&
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN
    );
  }

  /**
   * Get the JWT token received from the server after authentication.
   *
   * @returns The JWT token as a string, or null if not authenticated
   */
  public get token(): string | null {
    return this._token;
  }

  /**
   * Get the WebSocket connection URL.
   *
   * @returns The WebSocket URL as a string
   */
  public get connectionUrl(): string {
    const protocol = this.sslOptions ? 'wss' : 'ws';
    return `${protocol}://${this.host}:${this.port}/ext-module`;
  }

  /**
   * Establish a WebSocket connection to the CoreHub.
   *
   * @returns Promise resolving to the authentication token received from the server
   * @throws GluesyncConnectionError if the connection fails
   * @throws GluesyncAuthenticationError if authentication fails
   * @throws GluesyncTimeoutError if the connection times out
   */
  public async connect(): Promise<string> {
    if (this.isConnected) {
      log('Already connected to CoreHub');
      return this._token!;
    }

    try {
      log('Connecting to %s', this.connectionUrl);

      // Create WebSocket connection
      const wsOptions = {
        headers: this.headers,
        handshakeTimeout: this.timeout,
        rejectUnauthorized: this.verifySsl, // Use verifySsl parameter
        ...this.sslOptions,
      };

      // Create connection with timeout
      const connectionPromise = new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(this.connectionUrl, wsOptions) as WebSocket;

        ws.once('open', () => {
          resolve(ws);
        });

        ws.once('error', (err: Error) => {
          reject(
            new GluesyncConnectionError(`Connection error: ${err.message}`),
          );
        });
      });

      // Race connection against timeout
      this.ws = await Promise.race([
        connectionPromise,
        createTimeout(
          this.timeout,
          `Connection to ${this.host}:${this.port} timed out`,
        ).then(() => {
          throw new GluesyncTimeoutError(
            `Connection to ${this.host}:${this.port} timed out`,
          );
        }),
      ]);

      log('Connected to %s', this.connectionUrl);

      // Start the handshake by sending "hello"
      await this.sendMessage('hello');
      log('Sent "hello" message to CoreHub');

      // Wait for the token response
      const response = await Promise.race([
        this.receiveMessage(),
        createTimeout(
          this.timeout,
          `Handshake timed out after ${this.timeout}ms`,
        ).then(() => {
          throw new GluesyncTimeoutError(
            `Handshake timed out after ${this.timeout}ms`,
          );
        }),
      ]);

      // Check if the response is "pong" (should not happen at this stage)
      if (response === 'pong') {
        throw new GluesyncHandshakeError(
          'Unexpected "pong" message during handshake',
        );
      }

      // Store the token
      this._token = response;
      this.connected = true;
      log('Authentication successful, received token');

      // Set up message handlers and ping loop
      this.setupMessageHandlers();
      this.startPingLoop();

      // Call the connected callback if set
      if (this.onConnected) {
        await this.callCallback(this.onConnected, this._token);
      }

      return this._token;
    } catch (error) {
      // Clean up if connection failed
      if (this.ws) {
        this.ws.terminate();
        this.ws = null;
      }

      // Rethrow authentication errors
      if (
        error instanceof GluesyncAuthenticationError ||
        error instanceof GluesyncHandshakeError ||
        error instanceof GluesyncTimeoutError
      ) {
        throw error;
      }

      // Wrap other errors
      throw new GluesyncConnectionError(`Failed to connect: ${error}`);
    }
  }

  /**
   * Disconnect from the CoreHub.
   *
   * @returns Promise that resolves when disconnection is complete
   * @throws GluesyncConnectionError if an error occurs during disconnection
   */
  public async disconnect(): Promise<void> {
    if (!this.isConnected) {
      log('Not connected, nothing to disconnect');
      return;
    }

    log('Disconnecting from CoreHub');

    try {
      // Stop the ping loop
      this.stopPingLoop();

      // Close the WebSocket connection
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }

      // Reset connection state
      this._token = null;
      this.connected = false;

      // Call the disconnected callback if set
      if (this.onDisconnected) {
        await this.callCallback(this.onDisconnected, 'Disconnected by client');
      }

      log('Disconnected from CoreHub');
    } catch (error) {
      if (this.onError) {
        await this.callCallback(
          this.onError,
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      throw new GluesyncConnectionError(`Error during disconnection: ${error}`);
    }
  }

  /**
   * Set up message handlers for the WebSocket connection.
   */
  private setupMessageHandlers(): void {
    if (!this.ws) {
      return;
    }

    // Handle incoming messages
    this.ws.on('message', (data: WebSocket.Data) => {
      const message = data.toString();

      // Handle ping messages
      if (message === 'ping') {
        this.sendMessage('pong').catch(error => {
          log('Failed to send pong: %s', error);
        });
      }
    });

    // Handle connection close
    this.ws.on('close', async (code: number, reason: string) => {
      log('Connection closed: %d %s', code, reason);

      // Clean up
      this.stopPingLoop();
      this.ws = null;
      this._token = null;
      this.connected = false;

      // Call the disconnected callback if set
      if (this.onDisconnected) {
        await this.callCallback(
          this.onDisconnected,
          getErrorFromCloseReason(reason),
        );
      }
    });

    // Handle errors
    this.ws.on('error', async (error: Error) => {
      log('WebSocket error: %s', error.message);

      if (this.onError) {
        await this.callCallback(this.onError, error);
      }
    });
  }

  /**
   * Start the ping loop to keep the connection alive.
   */
  private startPingLoop(): void {
    // Stop any existing ping loop
    this.stopPingLoop();

    // Start a new ping loop
    this.pingIntervalId = setInterval(() => {
      if (this.isConnected) {
        this.sendMessage('ping').catch(error => {
          log('Failed to send ping: %s', error);
        });
      } else {
        this.stopPingLoop();
      }
    }, this.pingInterval);
  }

  /**
   * Stop the ping loop.
   */
  private stopPingLoop(): void {
    if (this.pingIntervalId) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
  }

  /**
   * Send a message to the CoreHub.
   *
   * @param message - Message to send
   * @returns Promise that resolves when the message is sent
   * @throws GluesyncClosedError if the connection is closed
   * @throws GluesyncConnectionError if sending fails
   */
  private sendMessage(message: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new GluesyncClosedError('Cannot send message: connection is not open'),
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.ws!.send(message, err => {
        if (err) {
          reject(
            new GluesyncConnectionError(
              `Failed to send message: ${err.message}`,
            ),
          );
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Receive a message from the CoreHub.
   *
   * @returns Promise resolving to the received message
   * @throws GluesyncClosedError if the connection is closed
   */
  private receiveMessage(): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new GluesyncClosedError(
          'Cannot receive message: connection is not open',
        ),
      );
    }

    return new Promise<string>((resolve, reject) => {
      const messageHandler = (data: WebSocket.Data) => {
        this.ws?.off('message', messageHandler);
        this.ws?.off('close', closeHandler);
        this.ws?.off('error', errorHandler);
        resolve(data.toString());
      };

      const closeHandler = (code: number, reason: string) => {
        this.ws?.off('message', messageHandler);
        this.ws?.off('close', closeHandler);
        this.ws?.off('error', errorHandler);
        reject(
          new GluesyncAuthenticationError(getErrorFromCloseReason(reason)),
        );
      };

      const errorHandler = (error: Error) => {
        this.ws?.off('message', messageHandler);
        this.ws?.off('close', closeHandler);
        this.ws?.off('error', errorHandler);
        reject(
          new GluesyncConnectionError(`Connection error: ${error.message}`),
        );
      };

      this.ws!.once('message', messageHandler);
      this.ws!.once('close', closeHandler);
      this.ws!.once('error', errorHandler);
    });
  }

  /**
   * Call a callback function safely, handling any exceptions.
   *
   * @param callback - The callback function to call
   * @param param - Parameter to pass to the callback
   */
  private async callCallback<T>(
    callback: CallbackFunction<T>,
    param: T,
  ): Promise<void> {
    try {
      const result = callback(param);
      if (result instanceof Promise) {
        await result;
      }
    } catch (error) {
      log('Error in callback: %s', error);
    }
  }
}
