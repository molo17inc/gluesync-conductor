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

import fs from 'fs';
import { URL } from 'url';
import { GluesyncClient, GluesyncConnectionError, GluesyncLicenseError, GluesyncAuthenticationError } from 'gluesync-nodejs-corehub-handshake-sdk';
import settings, { updateCoreHubUrl } from './config';

/**
 * Singleton class for managing the Gluesync SDK client connection
 */
export class GluesyncSDKClient {
  private static _instance: GluesyncSDKClient;
  private _token: string | null = null;
  private _client: GluesyncClient | null = null;
  private _isInitialized = false;
  private _reconnectTimer: NodeJS.Timeout | null = null;

  /**
   * Get the singleton instance
   */
  public static getInstance(): GluesyncSDKClient {
    if (!GluesyncSDKClient._instance) {
      GluesyncSDKClient._instance = new GluesyncSDKClient();
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

    const host = this._client.host;
    const port = this._client.port;
    const useSSL = this._client.useSSL;

    return this._buildCoreHubUrl(host, port, useSSL);
  }

  /**
   * Build a proper CoreHub URL with the given host, port and SSL setting
   * @param host The host name or IP address
   * @param port The port number
   * @param useSSL Whether to use HTTPS or HTTP
   * @returns The formatted CoreHub URL
   */
  private _buildCoreHubUrl(host: string, port: number, useSSL = false): string | null {
    if (!host) {
      return null;
    }

    // Use default port if none provided
    if (port === undefined || port === null) {
      port = 1717;
    }

    const scheme = useSSL ? 'https' : 'http';
    return `${scheme}://${host}:${port}`;
  }

  /**
   * Initialize the Gluesync client with indefinite retries and exponential backoff
   * The method will retry indefinitely with exponential backoff starting at 1 second,
   * doubling each time up to 30 seconds, then resetting back to 1 second.
   */
  public async initialize(): Promise<void> {
    if (this._isInitialized) {
      console.log('Gluesync SDK client already initialized');
      return;
    }

    // Parse host and port from CORE_HUB_URL if provided
    let host: string | null = null;
    let port: number | null = null;
    let useDiscovery = true;
    
    if (settings.coreHubUrl) {
      try {
        const url = new URL(settings.coreHubUrl);
        host = url.hostname;
        port = url.port ? parseInt(url.port, 10) : null;
        useDiscovery = false;
        console.log(`Using provided CoreHub URL: ${settings.coreHubUrl}`);
      } catch (error) {
        console.error(`Invalid CoreHub URL: ${settings.coreHubUrl}`, error);
      }
    } else {
      console.log('No CoreHub URL provided, will use UDP discovery');
    }

    // Get license file path from settings
    const licenseFilePath = settings.licenseFile;
    if (!fs.existsSync(licenseFilePath)) {
      console.warn(`License file not found at ${licenseFilePath}, will attempt to proceed without it`);
    }

    // SSL configuration
    let useSSL = settings.useSSL;
    if (settings.coreHubUrl && settings.coreHubUrl.startsWith('https:')) {
      useSSL = true;
    }

    // Security configuration
    let securityConfig = settings.securityConfig;
    if (securityConfig && !fs.existsSync(securityConfig)) {
      console.warn(`Security config file not found at ${securityConfig}, will use default settings`);
      securityConfig = undefined;
    }

    // Create the client
    this._client = new GluesyncClient({
      host: host ?? undefined,  // Undefined will trigger UDP discovery
      port: port !== null ? port : 1717,  // Use default port 1717 if null
      licenseFilePath: licenseFilePath,
      moduleTag: settings.moduleTag,
      useSSL: useSSL,
      securityConfig: securityConfig,
      verifySSL: !settings.skipSSLVerify
    });

    // Set up event handlers
    this._client.on('connected', this._onConnected.bind(this));
    this._client.on('disconnected', this._onDisconnected.bind(this));
    this._client.on('error', this._onError.bind(this));

    // Connect to CoreHub with indefinite retry logic and exponential backoff
    let retryCount = 0;
    let backoffDelay = 1000;  // Start with 1 second delay (in milliseconds)
    const maxBackoff = 30000;  // Maximum backoff of 30 seconds
    let cycleCount = 0;   // Count full cycles of backoff

    const tryConnect = async (): Promise<void> => {
      try {
        if (host && port) {
          console.log(`Connecting to CoreHub at ${host}:${port}...`);
          await this._client!.connect();
          return;  // Connection successful
        } else {
          // UDP discovery mode
          if (retryCount > 0) {
            console.log(`Retry ${retryCount} (cycle ${cycleCount}) for UDP discovery...`);
          } else {
            console.log('Starting UDP discovery to find CoreHub...');
          }
          
          await this._client!.connect();
          
          // After connect, check if we have a host (discovery worked)
          if (this._client!.host) {
            console.log(`UDP discovery successful! Found CoreHub at ${this._client!.host}:${this._client!.port}`);
            // Update the discovered host/port for future use
            host = this._client!.host;
            port = this._client!.port;
            
            // Update the CoreHub URL in settings
            const coreHubUrl = this._buildCoreHubUrl(host, port, useSSL);
            if (coreHubUrl) {
              updateCoreHubUrl(coreHubUrl);
              console.log(`Updated CoreHub URL to ${coreHubUrl}`);
            }
          } else {
            // If no host was discovered, raise an error to trigger retry
            throw new GluesyncConnectionError('UDP discovery did not find a CoreHub');
          }
        }
      } catch (error) {
        if (error instanceof GluesyncConnectionError) {
          if (host && port) {
            // If we have a specific host/port and can't connect, don't retry
            console.error(`Failed to connect to CoreHub at ${host}:${port}: ${error.message}`);
            throw error;
          } else {
            // For UDP discovery, retry with exponential backoff
            retryCount++;
            console.warn(`UDP discovery attempt ${retryCount} failed: ${(error as GluesyncConnectionError).message}`);
            
            // Schedule next retry with exponential backoff
            console.log(`Waiting ${backoffDelay / 1000} seconds before next retry...`);
            this._reconnectTimer = setTimeout(async () => {
              // Double the backoff for next time, up to the maximum
              backoffDelay = Math.min(backoffDelay * 2, maxBackoff);
              
              // If we've reached max backoff, reset on the next failure
              if (backoffDelay >= maxBackoff) {
                backoffDelay = 1000;  // Reset to 1 second
                cycleCount++;   // Increment cycle count
                console.log(`Completed backoff cycle ${cycleCount}, resetting delay to 1 second`);
              }
              
              await tryConnect();
            }, backoffDelay);
          }
        } else if (
          error instanceof GluesyncLicenseError || 
          error instanceof GluesyncAuthenticationError
        ) {
          // Don't retry for these errors
          console.error(`Error: ${(error as Error).message}`);
          throw error;
        } else {
          // For other errors, log and don't retry
          console.error('Unexpected error:', error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
    };

    await tryConnect();
    this._isInitialized = true;
    console.log('Gluesync SDK client initialized successfully');
  }

  /**
   * Shutdown the Gluesync client
   */
  public async shutdown(): Promise<void> {
    // Clear any reconnect timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._client && this._client.isConnected) {
      console.log('Disconnecting from CoreHub...');
      await this._client.disconnect();
      this._isInitialized = false;
      this._token = null;
    }
  }

  /**
   * Handle the connected event
   * @param token The JWT token received from the server
   */
  private _onConnected(token: string): void {
    this._token = token;
    console.log('Connected to CoreHub successfully! Token received.');
  }

  /**
   * Handle the disconnected event
   * @param reason The reason for disconnection
   */
  private _onDisconnected(reason: string): void {
    this._token = null;
    this._isInitialized = false;
    console.log(`Disconnected from CoreHub: ${reason}`);
    
    // Try to reconnect if not shutting down intentionally
    if (reason !== 'Client disconnected') {
      console.log('Attempting to reconnect in 5 seconds...');
      this._reconnectTimer = setTimeout(() => {
        this.initialize().catch(error => {
          console.error('Failed to reconnect:', error);
        });
      }, 5000);
    }
  }

  /**
   * Handle the error event
   * @param error The exception that occurred
   */
  private _onError(error: Error): void {
    console.error(`Error in connection: ${error.message}`);
  }
}

// Create a global instance for easy import
export const gluesyncSdkClient = GluesyncSDKClient.getInstance();
