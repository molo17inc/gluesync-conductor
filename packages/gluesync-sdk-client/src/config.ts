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

import path from 'path';
import fs from 'fs';
import logger from './logger';

/**
 * Gluesync SDK configuration settings
 */
export interface GluesyncConfig {
  // CoreHub connection settings
  coreHubUrl?: string;
  coreHubHost?: string;
  coreHubPort?: number;

  // SSL/TLS settings
  useSSL: boolean;
  skipSSLVerify: boolean;
  sslCertFile?: string;
  sslKeyFile?: string;

  // License and security settings
  licenseFile: string;
  moduleTag: string;
  securityConfig?: string;

  // Server settings
  host: string;
  port: number;
  debug: boolean;

  // Other settings
  allowedOrigins: string[];
}

/**
 * Default settings with environment variable overrides
 */
const settings: GluesyncConfig = {
  // CoreHub connection settings
  coreHubUrl:
    process.env.GLUESYNC_HOST || process.env.CORE_HUB_ADDRESS || 'localhost',

  // SSL/TLS settings
  useSSL: process.env.SSL_ENABLED?.trim().toLowerCase() === 'true',
  skipSSLVerify: process.env.SSL_SKIP_VERIFY?.toLowerCase() === 'true',
  sslCertFile: process.env.SSL_CERT_FILE,
  sslKeyFile: process.env.SSL_KEY_FILE,

  // License and security settings
  licenseFile:
    process.env.GLUESYNC_LICENSE_FILE || '/opt/gluesync/data/gs-license.dat',
  moduleTag: process.env.GLUESYNC_MODULE_TAG || 'conductor',
  securityConfig:
    process.env.GLUESYNC_SECURITY_CONFIG ||
    '/opt/gluesync/data/security-config.json',

  // Server settings
  host: process.env.HOST || '0.0.0.0',
  port: parseInt(process.env.PORT || '50000', 10),
  debug: process.env.DEBUG?.trim().toLowerCase() === 'true',

  // Other settings
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*').split(','),
};

/**
 * Update CoreHub URL in settings
 * @param url The CoreHub URL to use
 */
export const updateCoreHubUrl = (url: string | null): void => {
  if (!url) return;

  settings.coreHubUrl = url;

  // Parse the URL to extract host and port
  try {
    const parsedUrl = new URL(url);
    settings.coreHubHost = parsedUrl.hostname;
    settings.coreHubPort =
      parseInt(parsedUrl.port, 10) ||
      (parsedUrl.protocol === 'https:' ? 443 : 80);
    settings.useSSL = parsedUrl.protocol === 'https:';
    logger.info(
      {
        url,
        host: settings.coreHubHost,
        port: settings.coreHubPort,
        useSSL: settings.useSSL,
      },
      'CoreHub URL, host, port, and SSL settings',
    );
  } catch (error) {
    logger.error({ url, error }, 'Invalid CoreHub URL');
  }
};

/**
 * Ensure required directories exist
 */
export const ensureDirectories = (): void => {
  const dataDir = path.dirname(settings.licenseFile);
  if (!fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      logger.info({ dataDir }, 'Created data directory');
    } catch (error) {
      logger.error({ error, dataDir }, 'Failed to create data directory');
    }
  }
};

export default settings;
