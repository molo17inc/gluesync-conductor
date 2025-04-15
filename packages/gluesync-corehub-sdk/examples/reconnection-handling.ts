/**
 * Advanced example demonstrating reconnection handling with the Gluesync SDK.
 *
 * This example shows:
 * 1. Setting up a GluesyncClient with event handlers
 * 2. Implementing automatic reconnection with exponential backoff
 * 3. Handling various connection events
 * 4. Graceful shutdown
 *
 * Usage:
 * - Make sure you have a valid gs-license.dat file in the current directory
 * - Set the CORE_HUB_ADDRESS environment variable or use autodiscovery
 * - Run with: npx ts-node reconnection-handling.ts
 */

import { GluesyncClient } from '../src';

// Set up logging
const DEBUG = process.env.DEBUG || 'gluesync:*';
process.env.DEBUG = DEBUG;

// Configuration
const config = {
  host: process.env.CORE_HUB_ADDRESS || null,
  port: 1717,
  licenseFilePath: './gs-license.dat',
  moduleTag: 'nodejs-reconnect-example',
  ssl: false,
  // Reconnection settings
  initialReconnectDelay: 1000, // 1 second
  maxReconnectDelay: 30000, // 30 seconds
  reconnectBackoffMultiplier: 1.5,
  maxReconnectAttempts: 10,
};

class GluesyncClientManager {
  private client: GluesyncClient;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay: number = config.initialReconnectDelay;
  private isShuttingDown: boolean = false;

  constructor() {
    // Create the client
    this.client = new GluesyncClient({
      host: config.host,
      port: config.port,
      licenseFilePath: config.licenseFilePath,
      moduleTag: config.moduleTag,
      ssl: config.ssl,
    });

    // Set up event handlers
    this.setupEventHandlers();

    // Set up process signal handlers for graceful shutdown
    this.setupSignalHandlers();
  }

  /**
   * Set up event handlers for the client
   */
  private setupEventHandlers(): void {
    // Connected event
    this.client.onConnected = token => {
      console.log(`Connected to CoreHub successfully!`);
      console.log(`Received token: ${token.substring(0, 20)}...`);

      // Reset reconnection state on successful connection
      this.reconnectAttempts = 0;
      this.reconnectDelay = config.initialReconnectDelay;
    };

    // Disconnected event
    this.client.onDisconnected = reason => {
      console.log(`Disconnected from CoreHub: ${reason}`);

      // Attempt to reconnect if not shutting down
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    };

    // Error event
    this.client.onError = error => {
      console.error(`Error occurred: ${error.message}`);
    };
  }

  /**
   * Set up process signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', async () => {
      console.log('\nReceived SIGINT signal. Shutting down gracefully...');
      await this.shutdown();
      process.exit(0);
    });

    // Handle SIGTERM
    process.on('SIGTERM', async () => {
      console.log('\nReceived SIGTERM signal. Shutting down gracefully...');
      await this.shutdown();
      process.exit(0);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', async error => {
      console.error(`Uncaught exception: ${error.message}`);
      console.error(error.stack);
      await this.shutdown();
      process.exit(1);
    });
  }

  /**
   * Connect to CoreHub
   */
  public async connect(): Promise<void> {
    try {
      console.log('Connecting to CoreHub...');
      await this.client.connect();
      console.log(`Connection status: ${this.client.connectionStatus}`);
    } catch (error) {
      console.error(`Failed to connect: ${error}`);

      // Schedule reconnection
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    // Clear any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Check if we've exceeded the maximum number of attempts
    if (this.reconnectAttempts >= config.maxReconnectAttempts) {
      console.error(
        `Maximum reconnection attempts (${config.maxReconnectAttempts}) reached. Giving up.`,
      );
      return;
    }

    // Increment the reconnect attempts counter
    this.reconnectAttempts++;

    // Calculate the next reconnect delay with exponential backoff
    const delay = Math.min(
      this.reconnectDelay *
        Math.pow(config.reconnectBackoffMultiplier, this.reconnectAttempts - 1),
      config.maxReconnectDelay,
    );

    console.log(
      `Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay / 1000} seconds...`,
    );

    // Schedule the reconnection
    this.reconnectTimer = setTimeout(async () => {
      try {
        console.log(
          `Attempting to reconnect (attempt ${this.reconnectAttempts} of ${config.maxReconnectAttempts})...`,
        );
        await this.connect();
      } catch (error) {
        console.error(`Reconnection attempt failed: ${error}`);
      }
    }, delay);
  }

  /**
   * Gracefully shut down the client
   */
  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Clear any reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Disconnect if connected
    if (this.client.isConnected) {
      console.log('Disconnecting from CoreHub...');
      try {
        await this.client.disconnect();
        console.log('Disconnected successfully.');
      } catch (error) {
        console.error(`Error during disconnection: ${error}`);
      }
    }
  }
}

/**
 * Main function to run the example
 */
async function main() {
  console.log('Starting Gluesync CoreHub reconnection example...');

  // Create the client manager
  const clientManager = new GluesyncClientManager();

  // Connect to CoreHub
  await clientManager.connect();

  // Keep the process running
  console.log('Example is running. Press Ctrl+C to exit.');
}

// Run the example
main().catch(console.error);
