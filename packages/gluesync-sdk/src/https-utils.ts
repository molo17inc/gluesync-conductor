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
import { execSync } from 'child_process';
import { FastifyInstance } from 'fastify';
import settings from './config';

// Temporary directory for extracted certificates
const tempDir = path.join(process.cwd(), 'temp-certs');
let tempCertPath: string | null = null;
let tempKeyPath: string | null = null;

/**
 * Interface for SSL configuration
 */
export interface SSLConfig {
  key: Buffer;
  cert: Buffer;
}

/**
 * Create HTTP to HTTPS redirect middleware
 * @param app The Fastify instance
 */
export function setupHttpsRedirect(app: FastifyInstance) {
  // Only add the redirect if SSL is enabled
  if (!settings.useSSL) {
    return;
  }

  app.addHook('onRequest', (request, reply, done) => {
    // Check if request is from a browser (not API client)
    const userAgent = request.headers['user-agent']?.toLowerCase() || '';
    const isBrowser = userAgent.includes('mozilla') || 
                      userAgent.includes('chrome') || 
                      userAgent.includes('safari') || 
                      userAgent.includes('edge');
    
    // Only redirect browsers, not API clients
    if (request.protocol === 'http' && isBrowser) {
      try {
        // Get the host from request headers
        const host = request.headers.host || `${settings.host}:${settings.port}`;
        const hostname = host.includes(':') ? host.split(':')[0] : host;
        
        // Create HTTPS URL
        const httpsUrl = `https://${hostname}:${settings.port.toString()}${request.url}`;
        
        console.log(`Redirecting browser from HTTP to HTTPS: ${httpsUrl}`);
        reply.redirect(307, httpsUrl);
        return;
      } catch (error) {
        console.error('Error in redirect middleware:', error);
      }
    }
    
    done();
  });
}

/**
 * Extract certificates from PKCS12 file
 * @returns An object with cert and key paths, or null if extraction fails
 */
export function extractFromPkcs12(): { certPath: string | null, keyPath: string | null } {
  // Check for PKCS12 file path from environment or security config
  let p12Path = process.env.SSL_P12_PATH;
  let certPassword = process.env.SSL_CERT_PASSWORD;
  let keyPassword = process.env.SSL_KEY_PASSWORD;
  
  // Check security config if environment variables not set
  if (!p12Path && fs.existsSync(settings.securityConfig || '')) {
    try {
      const securityConfig = JSON.parse(fs.readFileSync(settings.securityConfig!, 'utf8'));
      if (securityConfig.ssl) {
        p12Path = securityConfig.ssl.sslCertificatePath;
        certPassword = securityConfig.ssl.certificatePassword;
        keyPassword = securityConfig.ssl.certificateKeyPassword || certPassword;
      }
    } catch (error) {
      console.error('Error reading security config:', error);
    }
  }
  
  // If no PKCS12 file found or password missing, return null
  if (!p12Path || !certPassword || !fs.existsSync(p12Path)) {
    return { certPath: null, keyPath: null };
  }
  
  // Use certificate password for key password if not specified
  if (!keyPassword) {
    keyPassword = certPassword;
  }
  
  console.log(`Using PKCS12 file: ${p12Path} with password: ${'*'.repeat(certPassword.length)} and key password: ${'*'.repeat(keyPassword.length)}`);
  
  try {
    // Create temporary directory for extraction if it doesn't exist
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Generate unique names for temporary files
    const timestamp = Date.now();
    tempCertPath = path.join(tempDir, `cert-${timestamp}.pem`);
    tempKeyPath = path.join(tempDir, `key-${timestamp}.pem`);
    
    // Extract certificate
    execSync(
      `openssl pkcs12 -in "${p12Path}" -passin pass:${certPassword} -nokeys -out "${tempCertPath}"`,
      { stdio: 'pipe' }
    );
    
    // Extract key without encryption (nodes = no DES encryption)
    execSync(
      `openssl pkcs12 -in "${p12Path}" -passin pass:${certPassword} -nocerts -out "${tempKeyPath}" -nodes`,
      { stdio: 'pipe' }
    );
    
    console.log(`Successfully extracted certificate and key from PKCS12 file: ${p12Path}`);
    return { certPath: tempCertPath, keyPath: tempKeyPath };
  } catch (error) {
    console.error('Failed to extract certificate from PKCS12:', error);
    return { certPath: null, keyPath: null };
  }
}

/**
 * Get SSL configuration for HTTPS server
 * @returns SSL configuration with key and certificate
 */
export function getSSLConfig(): SSLConfig | null {
  if (!settings.useSSL) {
    return null;
  }
  
  // Check for SSL certificate paths from environment
  let certFile = settings.sslCertFile;
  let keyFile = settings.sslKeyFile;
  
  // If not available, try extracting from PKCS12
  if (!(certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile))) {
    const { certPath, keyPath } = extractFromPkcs12();
    if (certPath && keyPath) {
      certFile = certPath;
      keyFile = keyPath;
      
      // Set environment variables for the extracted files
      process.env.SSL_CERT_FILE = certPath;
      process.env.SSL_KEY_FILE = keyPath;
    } else {
      console.warn('SSL not available - could not find certificate and key files');
      settings.useSSL = false;
      return null;
    }
  }
  
  try {
    const key = fs.readFileSync(keyFile);
    const cert = fs.readFileSync(certFile);
    return { key, cert };
  } catch (error) {
    console.error('Error reading SSL certificate files:', error);
    settings.useSSL = false;
    return null;
  }
}

/**
 * Clean up temporary SSL files
 */
export function cleanupSSLFiles(): void {
  if (tempCertPath && fs.existsSync(tempCertPath)) {
    try {
      fs.unlinkSync(tempCertPath);
      console.log(`Removed temporary certificate file: ${tempCertPath}`);
    } catch (error) {
      console.error(`Failed to remove temporary certificate file: ${error}`);
    }
  }
  
  if (tempKeyPath && fs.existsSync(tempKeyPath)) {
    try {
      fs.unlinkSync(tempKeyPath);
      console.log(`Removed temporary key file: ${tempKeyPath}`);
    } catch (error) {
      console.error(`Failed to remove temporary key file: ${error}`);
    }
  }
  
  if (fs.existsSync(tempDir)) {
    try {
      // Only remove directory if it's empty
      const files = fs.readdirSync(tempDir);
      if (files.length === 0) {
        fs.rmdirSync(tempDir);
        console.log(`Removed temporary directory: ${tempDir}`);
      }
    } catch (error) {
      console.error(`Failed to remove temporary directory: ${error}`);
    }
  }
}
