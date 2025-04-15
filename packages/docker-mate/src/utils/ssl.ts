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
import path from 'path';
import { FastifyServerOptions, FastifyHttpsOptions } from 'fastify';
import { Server as HttpsServer } from 'https';

/**
 * Check if SSL is enabled based on environment variables
 */
export function isSslEnabled(): boolean {
  return process.env.SSL_ENABLED === 'true';
}

/**
 * Check if SSL certificate verification should be skipped
 */
export function shouldSkipSslVerify(): boolean {
  return process.env.SSL_SKIP_VERIFY === 'true';
}

/**
 * Get SSL certificate and key file paths from environment variables
 */
export function getSslFilePaths(): { certFile: string | null; keyFile: string | null } {
  const certFile = process.env.SSL_CERT_FILE || null;
  const keyFile = process.env.SSL_KEY_FILE || null;
  
  // Verify files exist
  if (certFile && !fs.existsSync(certFile)) {
    console.warn(`SSL certificate file not found: ${certFile}`);
    return { certFile: null, keyFile: null };
  }
  
  if (keyFile && !fs.existsSync(keyFile)) {
    console.warn(`SSL key file not found: ${keyFile}`);
    return { certFile: null, keyFile: null };
  }
  
  return { certFile, keyFile };
}

/**
 * Create Fastify HTTPS options if SSL is enabled
 */
export function createFastifyHttpsOptions(): FastifyServerOptions {
  const baseOptions: FastifyServerOptions = {
    logger: process.env.DEBUG === 'true',
    ignoreTrailingSlash: true,
    ajv: {
      customOptions: {
        strict: false,
        removeAdditional: false
      }
    }
  };
  
  if (!isSslEnabled()) {
    return baseOptions;
  }
  
  const { certFile, keyFile } = getSslFilePaths();
  
  if (!certFile || !keyFile) {
    console.warn('SSL is enabled but certificate or key file is missing. Falling back to HTTP.');
    return baseOptions;
  }
  
  try {
    // Create HTTPS options with proper type casting
    // Use a more generic type to avoid TypeScript errors with the HTTPS options
    const httpsOptions = {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certFile),
      // Allow older TLS versions for compatibility
      minVersion: 'TLSv1',
      // Skip certificate verification if configured
      rejectUnauthorized: !shouldSkipSslVerify()
    };
    
    // Return server options with HTTPS
    return {
      ...baseOptions,
      https: httpsOptions
    } as any; // Use type assertion to bypass TypeScript checking
  } catch (error) {
    console.error('Error creating HTTPS options:', error);
    console.warn('Falling back to HTTP mode');
    return baseOptions;
  }
}

/**
 * Log helpful SSL information
 */
export function logSslInfo(): void {
  if (!isSslEnabled()) {
    return;
  }
  
  const { certFile, keyFile } = getSslFilePaths();
  
  if (!certFile || !keyFile) {
    console.warn('SSL is enabled but certificate or key file is missing.');
    return;
  }
  
  console.info('SSL is enabled with the following configuration:');
  console.info(`- Certificate file: ${certFile}`);
  console.info(`- Key file: ${keyFile}`);
  
  if (shouldSkipSslVerify()) {
    console.warn('SSL certificate verification is DISABLED');
    console.warn('For Chrome, type "thisisunsafe" when certificate warning appears');
    console.warn('For Firefox, you may need to add a security exception');
  }
}
