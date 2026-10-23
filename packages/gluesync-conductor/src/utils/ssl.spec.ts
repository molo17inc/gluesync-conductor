import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import loadWithStubs from '../testing/loadWithStubs';

type Subject = typeof import('./ssl');

const envKeys = [
  'SSL_ENABLED',
  'SSL_CERT_FILE',
  'SSL_KEY_FILE',
  'SSL_SKIP_VERIFY',
] as const;
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));

const sharedLogger = { id: 'the-process-logger' };

const load = (): Subject =>
  loadWithStubs<Subject>(path.resolve(__dirname, './ssl'), {
    [path.resolve(__dirname, './logger')]: { getLogger: () => sharedLogger },
  });

describe('createFastifyHttpsOptions', () => {
  beforeEach(() => {
    envKeys.forEach(key => delete process.env[key]);
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    envKeys.forEach(key => {
      const value = savedEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    mock.restoreAll();
  });

  it('uses the process logger instance and plain HTTP by default', () => {
    const options = load().createFastifyHttpsOptions() as Record<
      string,
      unknown
    >;
    assert.equal(options.loggerInstance, sharedLogger);
    assert.equal(options.https, undefined);
    assert.deepEqual(options.routerOptions, { ignoreTrailingSlash: true });
  });

  it('falls back to HTTP when SSL is enabled without certificate files', () => {
    process.env.SSL_ENABLED = 'true';
    const options = load().createFastifyHttpsOptions() as Record<
      string,
      unknown
    >;
    assert.equal(options.https, undefined);
    assert.equal(options.loggerInstance, sharedLogger);
    assert.equal((console.warn as any).mock.callCount(), 1);
  });

  it('serves HTTPS with the configured certificate and key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-spec-'));
    try {
      fs.writeFileSync(path.join(dir, 'c.pem'), 'CERT');
      fs.writeFileSync(path.join(dir, 'k.pem'), 'KEY');
      process.env.SSL_ENABLED = 'TRUE';
      process.env.SSL_CERT_FILE = path.join(dir, 'c.pem');
      process.env.SSL_KEY_FILE = path.join(dir, 'k.pem');
      process.env.SSL_SKIP_VERIFY = 'true';
      const options = load().createFastifyHttpsOptions() as unknown as {
        loggerInstance: unknown;
        https: {
          key: Buffer;
          cert: Buffer;
          minVersion: string;
          rejectUnauthorized: boolean;
        };
      };
      assert.equal(options.loggerInstance, sharedLogger);
      assert.equal(options.https.key.toString(), 'KEY');
      assert.equal(options.https.cert.toString(), 'CERT');
      assert.equal(options.https.minVersion, 'TLSv1.2');
      assert.equal(options.https.rejectUnauthorized, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
