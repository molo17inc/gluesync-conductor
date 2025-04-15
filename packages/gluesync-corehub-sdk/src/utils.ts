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

import * as fs from 'fs/promises';
import * as forge from 'node-forge';
import * as tls from 'tls';
import JSZip from 'jszip';
import { randomBytes } from 'crypto';

// Assume a logger is available
const logger = console; // Replace with actual logger if available

/**
 * Create an SSL/TLS context from a Java KeyStore (JKS) file.
 *
 * @param keystorePath - Path to the JKS file
 * @param keystorePassword - Password for the JKS file
 * @param alias - Alias for the certificate (optional)
 * @param keyPassword - Password for the private key (optional)
 * @returns SSL/TLS options object for use with Node.js tls/https module
 * @throws Error if keystore processing fails
 */
export async function createSslContextFromJks(
  keystorePath: string,
  keystorePassword: string,
  alias?: string,
  keyPassword?: string,
): Promise<tls.ConnectionOptions> {
  logger.info(`Creating SSL context from keystore: ${keystorePath}`);

  try {
    const jksData = await fs.readFile(keystorePath);
    const zip = await JSZip.loadAsync(jksData);
    const certs: string[] = [];

    for (const [, file] of Object.entries(zip.files)) {
      const content = await file.async('string');
      if (content.includes('-----BEGIN CERTIFICATE-----')) {
        certs.push(content);
      } else {
        try {
          const derBytes = forge.util.createBuffer(content);
          const asn1 = forge.asn1.fromDer(derBytes);
          const cert = forge.pki.certificateFromAsn1(asn1);
          const pemCert = forge.pki.certificateToPem(cert);
          certs.push(pemCert);
        } catch (e) {
          logger.warn('Failed to parse certificate:', e);
        }
      }
    }

    if (certs.length === 0) {
      throw new Error('No valid certificates found in the keystore');
    }

    const selectedCerts = alias
      ? certs.filter(cert => cert.includes(alias))
      : certs;

    return {
      ca: selectedCerts,
      checkServerIdentity: () => undefined,
      rejectUnauthorized: true,
      passphrase: keyPassword || keystorePassword,
    };
  } catch (error) {
    logger.error(`Failed to create SSL context: ${error}`);
    throw new Error(`Failed to create SSL context: ${error}`);
  }
}

/**
 * Parse a WebSocket close reason into error code and message.
 *
 * @param reason - The close reason string from the WebSocket
 * @returns Tuple of [errorCode, errorMessage]
 */
export function parseCloseReason(reason: string): [string, string] {
  if (reason.includes(':')) {
    const parts = reason.split(':', 2);
    return [parts[0].trim(), parts[1].trim()];
  }
  return ['UNKNOWN', reason];
}

/**
 * Extract a user-friendly error message from a close reason.
 *
 * @param reason - The close reason string from the WebSocket
 * @returns An error message suitable for display to the user
 */
export function getErrorFromCloseReason(reason: string): string {
  const [errorCode, errorMessage] = parseCloseReason(reason);

  const errorMessages: Record<string, string> = {
    NOT_CONSISTENT:
      'Authentication failed: Invalid headers or license information',
    VIOLATED_POLICY: 'License not valid or expired',
    INTERNAL_ERROR:
      'Server error: Please check CoreHub logs for more information',
    CLOSED_ABNORMALLY: 'Connection closed unexpectedly',
  };

  return errorMessages[errorCode] || errorMessage;
}

/**
 * Create a promise that rejects after a specified timeout.
 *
 * @param ms - Timeout in milliseconds
 * @param message - Error message
 * @returns A promise that rejects after the timeout
 */
export function createTimeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Generate a random ID for tracking purposes.
 *
 * @returns A random string ID
 */
export function generateId(): string {
  return randomBytes(8).toString('hex');
}
