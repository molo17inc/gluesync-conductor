import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import loadWithStubs from '../testing/loadWithStubs';

type Introspect = (opts: {
  cookieHeader: string | undefined;
  authorizationHeader: string | undefined;
}) => Promise<{ username: string; role: string } | null>;

type Subject = typeof import('./corehubIntrospect');

type Sdk = Readonly<{ coreHubUrl?: string | null; fails?: boolean }>;

const envKeys = [
  'CONDUCTOR_AUTH_CACHE_TTL',
  'CONDUCTOR_COREHUB_URL_OVERRIDE',
  'GLUESYNC_HOST',
  'CORE_HUB_ADDRESS',
  'SSL_ENABLED',
  'SSL_SKIP_VERIFY',
  'SKIP_TLS_VERIFICATION',
] as const;
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));

afterEach(() => {
  envKeys.forEach(key => {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
});

const load = (
  env: Partial<Record<(typeof envKeys)[number], string>> = {},
  sdk: Sdk = {},
) => {
  envKeys.forEach(key => delete process.env[key]);
  Object.entries(env).forEach(([key, value]) => {
    process.env[key] = value;
  });
  const urls: string[] = [];
  const clients: Record<string, unknown>[] = [];
  const subject = loadWithStubs<Subject>(
    path.resolve(__dirname, './corehubIntrospect'),
    {
      axios: {
        default: {
          create: (config: Record<string, unknown>) => {
            clients.push(config);
            return {
              get: async (url: string) => {
                urls.push(url);
                return {
                  status: 200,
                  data: { username: 'admin', role: 'MANAGER' },
                };
              },
            };
          },
        },
      },
      [path.resolve(__dirname, '../gluesyncSdkClient')]: {
        getGluesyncSdkClient: () => {
          if (sdk.fails) {
            throw new Error('SDK not created yet');
          }
          return { coreHubUrl: sdk.coreHubUrl };
        },
      },
      [path.resolve(__dirname, '../utils/logger')]: {
        getLogger: () => ({ debug: () => {}, warn: () => {} }),
      },
    },
  );
  return { subject, urls, clients };
};

const asBearer = (introspect: Introspect) =>
  introspect({ authorizationHeader: 'Bearer t', cookieHeader: undefined });

describe('createIntrospector cache lifetime', () => {
  it('keeps an answer for 5 seconds by default', async () => {
    const { subject, urls } = load();
    const { introspect } = subject.createIntrospector({
      corehubUrlProvider: () => 'https://hub:1717/',
    });
    assert.deepEqual(await asBearer(introspect), {
      username: 'admin',
      role: 'MANAGER',
    });
    await asBearer(introspect);
    assert.deepEqual(urls, ['https://hub:1717/authentication/me']);
  });

  it('takes the lifetime from CONDUCTOR_AUTH_CACHE_TTL', async () => {
    const { subject, urls } = load({ CONDUCTOR_AUTH_CACHE_TTL: '0' });
    const { introspect } = subject.createIntrospector({
      corehubUrlProvider: () => 'https://hub:1717',
    });
    await asBearer(introspect);
    await asBearer(introspect);
    assert.equal(urls.length, 2);
  });

  it('asks CoreHub again after invalidate()', async () => {
    const { subject, urls } = load();
    const { introspect, invalidate } = subject.createIntrospector({
      corehubUrlProvider: () => 'https://hub:1717',
    });
    await asBearer(introspect);
    invalidate();
    await asBearer(introspect);
    assert.equal(urls.length, 2);
  });
});

describe('default introspector CoreHub address', () => {
  const urlSeenBy = async (
    env: Partial<Record<(typeof envKeys)[number], string>>,
    sdk: Sdk = {},
  ): Promise<string | undefined> => {
    const { subject, urls } = load(env, sdk);
    await asBearer(subject.getIntrospector().introspect);
    return urls[0];
  };

  it('prefers the explicit override', async () => {
    assert.equal(
      await urlSeenBy(
        { CONDUCTOR_COREHUB_URL_OVERRIDE: 'https://override:9' },
        { coreHubUrl: 'https://discovered:1' },
      ),
      'https://override:9/authentication/me',
    );
  });

  it('uses the address the SDK discovered', async () => {
    assert.equal(
      await urlSeenBy(
        { GLUESYNC_HOST: 'configured' },
        { coreHubUrl: 'https://discovered:1717' },
      ),
      'https://discovered:1717/authentication/me',
    );
  });

  it('falls back to GLUESYNC_HOST while the SDK is reconnecting', async () => {
    assert.equal(
      await urlSeenBy({ GLUESYNC_HOST: ' corehub ' }, { coreHubUrl: null }),
      'http://corehub:1717/authentication/me',
    );
  });

  it('falls back to CORE_HUB_ADDRESS over https when SSL is enabled', async () => {
    assert.equal(
      await urlSeenBy(
        { CORE_HUB_ADDRESS: 'corehub.local', SSL_ENABLED: 'TRUE' },
        { fails: true },
      ),
      'https://corehub.local:1717/authentication/me',
    );
  });

  it('keeps a configured address that already has a scheme', async () => {
    assert.equal(
      await urlSeenBy({ GLUESYNC_HOST: 'https://hub.example:8443' }),
      'https://hub.example:8443/authentication/me',
    );
  });

  it('cannot verify auth when no address is known anywhere', async () => {
    const { subject } = load({}, { fails: true });
    await assert.rejects(
      asBearer(subject.getIntrospector().introspect),
      /CoreHub URL not yet discovered/,
    );
  });

  it('skips certificate checks when asked to', () => {
    const { subject, clients } = load({
      SKIP_TLS_VERIFICATION: 'true',
      GLUESYNC_HOST: 'hub',
    });
    return asBearer(subject.getIntrospector().introspect).then(() => {
      assert.ok(clients[0].httpsAgent);
    });
  });
});

describe('introspector singleton', () => {
  it('returns the same instance until it is replaced or cleared', () => {
    const { subject } = load();
    const first = subject.getIntrospector();
    assert.equal(subject.getIntrospector(), first);
    const replacement = subject.createIntrospector({
      corehubUrlProvider: () => null,
    });
    subject.setIntrospector(replacement);
    assert.equal(subject.getIntrospector(), replacement);
    subject.setIntrospector(null);
    assert.notEqual(subject.getIntrospector(), replacement);
  });
});
