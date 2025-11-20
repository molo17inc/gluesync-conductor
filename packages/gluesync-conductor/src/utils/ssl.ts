import fs from 'fs';
import { FastifyServerOptions } from 'fastify';
import { getLoggerOptions } from './logger';

/**
 * Check if SSL is enabled based on environment variables
 */
export const isSslEnabled = (): boolean =>
  process.env.SSL_ENABLED?.trim().toLowerCase() === 'true';

/**
 * Check if SSL certificate verification should be skipped
 */
export const shouldSkipSslVerify = (): boolean =>
  process.env.SSL_SKIP_VERIFY?.trim().toLowerCase() === 'true';

/**
 * Get SSL certificate and key file paths from environment variables
 */
export const getSslFilePaths = (): {
  certFile: string | null;
  keyFile: string | null;
} => {
  const certFile = process.env.SSL_CERT_FILE || null;
  const keyFile = process.env.SSL_KEY_FILE || null;

  if (certFile && !fs.existsSync(certFile)) {
    console.warn(`SSL certificate file not found: ${certFile}`);
    return { certFile: null, keyFile: null };
  }

  if (keyFile && !fs.existsSync(keyFile)) {
    console.warn(`SSL key file not found: ${keyFile}`);
    return { certFile: null, keyFile: null };
  }

  return { certFile, keyFile };
};

/**
 * Create Fastify HTTPS options if SSL is enabled
 */
export const createFastifyHttpsOptions = (): FastifyServerOptions => {
  const loggerOptions = getLoggerOptions();

  const baseOptions: FastifyServerOptions = {
    logger: loggerOptions,
    routerOptions: {
      ignoreTrailingSlash: true,
    },
    ajv: {
      customOptions: {
        strict: false,
      },
    },
  };

  if (!isSslEnabled()) return baseOptions;

  const { certFile, keyFile } = getSslFilePaths();

  if (!certFile || !keyFile) {
    console.warn(
      'SSL is enabled but certificate or key file is missing. Falling back to HTTP.',
    );
    return baseOptions;
  }

  try {
    const httpsOptions = {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certFile),
      minVersion: 'TLSv1.2', // safer default than TLSv1
      // rejectUnauthorized is not used by Node's HTTPS server, but kept for compatibility
      rejectUnauthorized: !shouldSkipSslVerify(),
    };

    return {
      ...baseOptions,
      https: httpsOptions,
    } as any;
  } catch (error) {
    console.error('Error creating HTTPS options:', error);
    console.warn('Falling back to HTTP mode');
    return baseOptions;
  }
};

/**
 * Log helpful SSL information
 */
export const logSslInfo = (): void => {
  if (!isSslEnabled()) return;

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
    console.warn(
      'For Chrome, type "thisisunsafe" when certificate warning appears',
    );
    console.warn('For Firefox, you may need to add a security exception');
  }
};
