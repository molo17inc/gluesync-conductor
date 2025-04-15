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

import * as dgram from 'dgram';
import { /* createTimeout, */ generateId } from './utils';
import debug from 'debug';

// Set up debug logger
const log = debug('gluesync:discovery');

// Constants for discovery
export const DISCOVERY_MESSAGE = Buffer.from('GLUESYNC BROADCAST MESSAGE');
export const DEFAULT_START_PORT = 1717;
export const DEFAULT_PORT_RANGE = 10; // Will scan ports from START_PORT+1 to START_PORT+DEFAULT_PORT_RANGE
export const DEFAULT_TIMEOUT_MS = 15000; // 15 seconds timeout for discovery

/**
 * Provides UDP autodiscovery for CoreHub servers on the local network.
 */
export class CoreHubDiscovery {
  private startPort: number;
  private portRange: number;
  private portList: number[];
  private timeoutMs: number;
  private verifySsl: boolean;
  private socket: dgram.Socket | null = null;
  private discoveryPromise: Promise<string> | null = null;
  private discoveryResolve: ((value: string) => void) | null = null;
  private discoveryReject: ((reason: Error) => void) | null = null;
  private timeoutId: NodeJS.Timeout | null = null;
  private discoveryId: string;

  /**
   * Initialize the CoreHub discovery service.
   *
   * @param startPort - The base port number to use for discovery
   * @param portRange - The number of ports to scan (starting from startPort + 1)
   * @param timeoutMs - Timeout in milliseconds to wait for discovery
   */
  constructor(
    startPort: number = DEFAULT_START_PORT,
    portRange: number = DEFAULT_PORT_RANGE,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    verifySsl: boolean = true,
  ) {
    this.startPort = startPort;
    this.portRange = portRange;
    this.timeoutMs = timeoutMs;
    this.verifySsl = verifySsl;
    this.portList = Array.from(
      { length: portRange },
      (_, i) => startPort + i + 1,
    );
    this.discoveryId = generateId();
    log(
      'Created discovery instance %s with port range %d-%d',
      this.discoveryId,
      this.startPort + 1,
      this.startPort + this.portRange,
    );
  }

  /**
   * Listen for the CoreHub broadcast message and return the CoreHub IP address.
   *
   * @returns Promise resolving to the IP address of the CoreHub as a string
   * @throws Error if unable to bind to a socket or other network issues
   * @throws Error if no broadcast is received within the timeout period
   */
  async discoverCoreHub(verifySsl: boolean = this.verifySsl): Promise<string> {
    if (this.discoveryPromise) {
      log('Discovery already in progress, returning existing promise');
      return this.discoveryPromise;
    }

    this.discoveryPromise = new Promise<string>((resolve, reject) => {
      this.discoveryResolve = resolve;
      this.discoveryReject = reject;
    });

    try {
      // Choose a random port from the range to listen on
      const port =
        this.portList[Math.floor(Math.random() * this.portList.length)];

      // Create a UDP socket
      this.socket = dgram.createSocket('udp4');

      // Set up error handler
      this.socket.on('error', err => {
        log('Socket error: %s', err.message);
        this.cleanup();
        if (this.discoveryReject) {
          this.discoveryReject(
            new Error(`Failed to discover CoreHub: ${err.message}`),
          );
          this.discoveryReject = null;
        }
      });

      // Set up message handler
      this.socket.on('message', (data, rinfo) => {
        log(
          'Received data from %s:%d: %s',
          rinfo.address,
          rinfo.port,
          data.toString(),
        );

        // Check if this is the expected discovery message
        if (data.equals(DISCOVERY_MESSAGE)) {
          const corehubAddress = rinfo.address;
          log('CoreHub discovered at %s', corehubAddress);

          this.cleanup();
          if (this.discoveryResolve) {
            this.discoveryResolve(corehubAddress);
            this.discoveryResolve = null;
          }
        }
      });

      // Set up timeout
      this.timeoutId = setTimeout(() => {
        log('Discovery timed out after %d ms', this.timeoutMs);
        this.cleanup();
        if (this.discoveryReject) {
          this.discoveryReject(
            new Error(`Discovery timed out after ${this.timeoutMs} ms`),
          );
          this.discoveryReject = null;
        }
      }, this.timeoutMs);

      // Bind to the port
      try {
        await new Promise<void>((resolve, reject) => {
          if (!this.socket) {
            reject(new Error('Socket not initialized'));
            return;
          }

          this.socket.once('listening', () => {
            if (this.socket) {
              const address = this.socket.address();
              log('Listening for CoreHub broadcast on port %d', address.port);
            }
            resolve();
          });

          this.socket.once('error', err => {
            reject(err);
          });

          this.socket.bind(port);
        });

        log('Listening for broadcast messages on port %d', port);
      } catch (bindErr) {
        log('Failed to bind to port %d: %s', port, bindErr);

        // Try again with a different port
        this.cleanup();

        // Small delay before trying again
        await new Promise(resolve => setTimeout(resolve, 1000));

        return this.discoverCoreHub();
      }

      return this.discoveryPromise;
    } catch (error) {
      this.cleanup();
      log('Error during discovery: %s', error);
      throw new Error(`Failed to discover CoreHub: ${error}`);
    }
  }

  /**
   * Clean up resources when discovery completes or fails.
   */
  private cleanup() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {
        log('Error closing socket: %s', e);
      }
      this.socket = null;
    }

    this.discoveryPromise = null;
  }
}

/**
 * Get the CoreHub address from environment variable or via autodiscovery.
 *
 * @param envVarName - Name of the environment variable that might contain the CoreHub address
 * @param startPort - The base port number to use for discovery
 * @param portRange - The number of ports to scan (starting from startPort + 1)
 * @param timeoutMs - Timeout in milliseconds to wait for discovery
 * @param verifySsl - Whether to verify SSL certificates (default: true)
 * @returns Promise resolving to the IP address of the CoreHub as a string
 * @throws Error if unable to discover the CoreHub
 */
export async function getCorehubAddress(
  envVarName: string = 'CORE_HUB_ADDRESS',
  startPort: number = DEFAULT_START_PORT,
  portRange: number = DEFAULT_PORT_RANGE,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  verifySsl: boolean = true,
): Promise<string> {
  // First check if the address is provided via environment variable
  const coreHubAddress = process.env[envVarName];

  if (coreHubAddress) {
    log('Using CoreHub address from environment: %s', coreHubAddress);
    return coreHubAddress;
  }

  // If not provided, try to discover it on the network
  log('CoreHub address not provided, attempting autodiscovery...');
  try {
    const discovery = new CoreHubDiscovery(
      startPort,
      portRange,
      timeoutMs,
      verifySsl,
    );
    return await discovery.discoverCoreHub(verifySsl);
  } catch (error) {
    log('Failed to discover CoreHub: %s', error);
    throw new Error(
      `Failed to discover CoreHub. Please provide the CoreHub address via the ${envVarName} environment variable.`,
    );
  }
}
