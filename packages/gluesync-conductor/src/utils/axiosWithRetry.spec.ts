import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import loadWithStubs from '../testing/loadWithStubs';
import type { AxiosWithRetry } from './axisWithRetry.model';

type LogCall = Readonly<{ level: string; data: unknown; msg?: string }>;

type Axios = {
  (config: Record<string, unknown>): Promise<unknown>;
  isAxiosError: (error: unknown) => boolean;
};

const envKeys = ['PROXY_HTTPS', 'PROXY_HTTP', 'NO_PROXY', 'no_proxy'] as const;
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
const realUrl = globalThis.URL;

afterEach(() => {
  envKeys.forEach(key => {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  globalThis.URL = realUrl;
});

const load = (
  env: Partial<Record<(typeof envKeys)[number], string>> = {},
  respond: (
    config: Record<string, unknown>,
  ) => Promise<unknown> = async () => ({
    status: 200,
    data: { ok: true },
  }),
) => {
  envKeys.forEach(key => delete process.env[key]);
  Object.entries(env).forEach(([key, value]) => {
    process.env[key] = value;
  });
  const logs: LogCall[] = [];
  const requests: Record<string, unknown>[] = [];
  const agents: string[] = [];
  const record =
    (level: string) =>
    (data: unknown, msg?: string): void => {
      logs.push(
        typeof data === 'string'
          ? { level, data: {}, msg: data }
          : { level, data, msg },
      );
    };
  const fakeLogger = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };
  const axios: Axios = Object.assign(
    async (config: Record<string, unknown>) => {
      requests.push(config);
      return respond(config);
    },
    {
      isAxiosError: (error: unknown) =>
        (error as { isAxiosError?: boolean } | null)?.isAxiosError === true,
    },
  );
  const mod = loadWithStubs<{ default: AxiosWithRetry }>(
    path.resolve(__dirname, './axiosWithRetry'),
    {
      axios: { default: axios, AxiosError: Error },
      'https-proxy-agent': {
        HttpsProxyAgent: function HttpsProxyAgent(url: string) {
          agents.push(url);
        },
      },
      [path.resolve(__dirname, './logger')]: { getLogger: () => fakeLogger },
    },
  );
  return { call: mod.default, logs, requests, agents };
};

const messages = (logs: ReadonlyArray<LogCall>, level: string): string[] =>
  logs.filter(l => l.level === level).map(l => l.msg ?? '');

describe('axiosWithRetry proxy configuration', () => {
  it('goes direct and says so when no proxy is configured', async () => {
    const { call, logs, requests, agents } = load();
    assert.ok(
      messages(logs, 'info').includes(
        'No proxy URL found, using direct connection',
      ),
    );
    assert.deepEqual(await call('https://hub.example/x'), { ok: true });
    assert.equal(requests[0].httpsAgent, undefined);
    assert.equal(requests[0].proxy, false);
    assert.equal(agents.length, 0);
  });

  it('never logs the credentials of the proxy URL', async () => {
    const { call, logs, requests, agents } = load({
      PROXY_HTTPS: 'http://user:pa%24%24word@proxy.local:3128',
    });
    const parsed = logs.find(l => l.msg === 'Parsed proxy config');
    assert.deepEqual(parsed?.data, {
      proxy: { host: 'proxy.local', port: 3128, authenticated: true },
    });
    await call('https://hub.example/x');
    assert.equal(JSON.stringify(logs).includes('word'), false);
    assert.equal(JSON.stringify(logs).includes('user'), false);
    // The agent itself still needs the real URL to authenticate.
    assert.deepEqual(agents, ['http://user:pa%24%24word@proxy.local:3128']);
    assert.ok(requests[0].httpsAgent);
  });

  it('logs a proxy URL without credentials as host and port only', () => {
    const { logs } = load({ PROXY_HTTP: 'https://proxy.local' });
    const parsed = logs.find(l => l.msg === 'Parsed proxy config');
    assert.deepEqual(parsed?.data, {
      proxy: { host: 'proxy.local', port: 443, authenticated: false },
    });
    assert.equal(JSON.stringify(logs).includes('https://proxy.local'), false);
  });

  it('skips the proxy for hosts in NO_PROXY', async () => {
    const { call, agents, requests } = load({
      PROXY_HTTPS: 'http://proxy.local:3128',
      NO_PROXY: 'internal.example, .corp',
    });
    await call('https://hub.internal.example/x');
    await call('not a url');
    assert.equal(requests[0].httpsAgent, undefined);
    assert.equal(agents.length, 1);
  });

  it('falls back to a direct connection when the proxy URL is unparseable', async () => {
    const { call, logs, requests } = load({ PROXY_HTTPS: 'not a proxy url' });
    const failure = logs.find(
      l => l.msg === 'Failed to parse proxy URL - falling back to direct',
    );
    assert.equal(failure?.level, 'error');
    assert.equal(JSON.stringify(logs).includes('not a proxy url'), false);
    assert.equal(
      logs.some(l => l.msg === 'Parsed proxy config'),
      false,
    );
    await call('https://hub.example/x');
    assert.equal(requests[0].httpsAgent, undefined);
  });

  it('reports a parse failure that is not an Error without the credentials', () => {
    // The parse throws a string instead of an Error.
    globalThis.URL = function FakeUrl() {
      // eslint-disable-next-line no-throw-literal
      throw 'boom';
    } as unknown as typeof URL;
    const { logs } = load({
      PROXY_HTTPS: 'http://user:secret@proxy.local:3128',
    });
    globalThis.URL = realUrl;
    const failure = logs.find(
      l => l.msg === 'Failed to parse proxy URL - falling back to direct',
    );
    assert.equal(failure?.level, 'error');
    assert.deepEqual(failure?.data, {});
    assert.equal(JSON.stringify(logs).includes('secret'), false);
    assert.equal(JSON.stringify(logs).includes('user'), false);
  });
});

describe('axiosWithRetry requests', () => {
  it('rethrows the axios error once the retries are used up', async () => {
    const failure = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 502 },
    });
    const { call, logs } = load({}, async () => {
      throw failure;
    });
    await assert.rejects(
      call('https://hub.example/x', { retries: 0 }),
      failure,
    );
    assert.ok(
      messages(logs, 'error').includes(
        '[axiosWithRetry] giving up after max retries',
      ),
    );
  });

  it('rethrows an error that does not come from axios', async () => {
    const { call, logs } = load({}, async () => {
      throw new TypeError('bad config');
    });
    await assert.rejects(call('https://hub.example/x'), /bad config/);
    assert.ok(
      messages(logs, 'warn').includes('[axiosWithRetry] non-axios error'),
    );
  });

  it('wraps a thrown value that is not an Error', async () => {
    const { call } = load({}, async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain text';
    });
    await assert.rejects(call('https://hub.example/x'), /plain text/);
  });
});
