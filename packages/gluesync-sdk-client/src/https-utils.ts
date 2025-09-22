import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import settings from './config';

// Temporary directory for extracted certificates
const tempDir = path.join(process.cwd(), 'temp-certs');
let tempCertPath: string | null = null;
let tempKeyPath: string | null = null;

export interface SSLConfig {
  key: Buffer;
  cert: Buffer;
}

export const setupHttpsRedirect = (app: any): void => {
  if (!settings.useSSL) return;

  app.addHook('onRequest', (request: any, reply: any, done: any) => {
    const userAgent = request.headers['user-agent']?.toLowerCase() || '';
    const isBrowser =
      userAgent.includes('mozilla') ||
      userAgent.includes('chrome') ||
      userAgent.includes('safari') ||
      userAgent.includes('edge');

    if (request.protocol === 'http' && isBrowser) {
      try {
        const host =
          request.headers.host || `${settings.host}:${settings.port}`;
        const hostname = host.includes(':') ? host.split(':')[0] : host;
        const httpsUrl = `https://${hostname}:${settings.port.toString()}${request.url}`;

        console.log(`Redirecting browser from HTTP to HTTPS: ${httpsUrl}`);
        reply.status(307).redirect(httpsUrl);
        return;
      } catch (error) {
        console.error('Error in redirect middleware:', error);
      }
    }
    done();
  });
};

export const extractFromPkcs12 = (): {
  certPath: string | null;
  keyPath: string | null;
} => {
  let p12Path = process.env.SSL_P12_PATH;
  let certPassword = process.env.SSL_CERT_PASSWORD;
  let keyPassword = process.env.SSL_KEY_PASSWORD;

  if (!p12Path && fs.existsSync(settings.securityConfig || '')) {
    try {
      const securityConfig = JSON.parse(
        fs.readFileSync(settings.securityConfig!, 'utf8'),
      );
      if (securityConfig.ssl) {
        p12Path = securityConfig.ssl.sslCertificatePath;
        certPassword = securityConfig.ssl.certificatePassword;
        keyPassword = securityConfig.ssl.certificateKeyPassword || certPassword;
      }
    } catch (error) {
      console.error('Error reading security config:', error);
    }
  }

  if (!p12Path || !certPassword || !fs.existsSync(p12Path)) {
    return { certPath: null, keyPath: null };
  }

  if (!keyPassword) keyPassword = certPassword;

  console.log(
    `Using PKCS12 file: ${p12Path} with password: ${'*'.repeat(certPassword.length)} and key password: ${'*'.repeat(keyPassword.length)}`,
  );

  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = Date.now();
    tempCertPath = path.join(tempDir, `cert-${timestamp}.pem`);
    tempKeyPath = path.join(tempDir, `key-${timestamp}.pem`);

    execSync(
      `openssl pkcs12 -in "${p12Path}" -passin pass:${certPassword} -nokeys -out "${tempCertPath}"`,
      { stdio: 'pipe' },
    );

    execSync(
      `openssl pkcs12 -in "${p12Path}" -passin pass:${certPassword} -nocerts -out "${tempKeyPath}" -nodes`,
      { stdio: 'pipe' },
    );

    console.log(
      `Successfully extracted certificate and key from PKCS12 file: ${p12Path}`,
    );
    return { certPath: tempCertPath, keyPath: tempKeyPath };
  } catch (error) {
    console.error('Failed to extract certificate from PKCS12:', error);
    return { certPath: null, keyPath: null };
  }
};

export const getSSLConfig = (): SSLConfig | null => {
  if (!settings.useSSL) return null;

  let certFile = settings.sslCertFile;
  let keyFile = settings.sslKeyFile;

  if (
    !(certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile))
  ) {
    const { certPath, keyPath } = extractFromPkcs12();
    if (certPath && keyPath) {
      certFile = certPath;
      keyFile = keyPath;
      process.env.SSL_CERT_FILE = certPath;
      process.env.SSL_KEY_FILE = keyPath;
    } else {
      console.warn(
        'SSL not available - could not find certificate and key files',
      );
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
};

export const cleanupSSLFiles = (): void => {
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
      const files = fs.readdirSync(tempDir);
      if (files.length === 0) {
        fs.rmdirSync(tempDir);
        console.log(`Removed temporary directory: ${tempDir}`);
      }
    } catch (error) {
      console.error(`Failed to remove temporary directory: ${error}`);
    }
  }
};
