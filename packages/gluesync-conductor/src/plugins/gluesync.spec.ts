import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import fastify from 'fastify';
import fp from 'fastify-plugin';
import pino from 'pino';

import loadWithStubs from '../testing/loadWithStubs';

type Subject = Readonly<{ default: (...args: any[]) => void }>;

type Sdk = Readonly<{
  /** results of the successive initialize() calls: true = ok, false = unreachable */
  initialize: ReadonlyArray<boolean | Promise<boolean>>;
  shutdownFails?: boolean;
}>;

const envKeys = [
  'GLUESYNC_MODULE_TAG',
  'GLUESYNC_LICENSE_FILE',
  'GLUESYNC_SECURITY_CONFIG',
] as const;
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));

const flush = (): Promise<void> =>
  new Promise(resolve => {
    setImmediate(resolve);
  });

const load = (sdk: Sdk, sdkClientFails = false) => {
  const settings: Record<string, unknown> = {};
  const state = { initializeCalls: 0, shutdownCalls: 0 };
  const warns: { data: any; msg: string }[] = [];
  const client = {
    coreHubUrl: 'https://hub:1717',
    token: 'token',
    initialize: async () => {
      const next = sdk.initialize[state.initializeCalls] ?? true;
      state.initializeCalls += 1;
      const ok = await next;
      if (!ok) {
        throw new Error('CoreHub unreachable');
      }
    },
    shutdown: async () => {
      state.shutdownCalls += 1;
      if (sdk.shutdownFails) {
        throw new Error('shutdown failed');
      }
    },
  };
  const subject = loadWithStubs<Subject>(
    path.resolve(__dirname, './gluesync'),
    {
      'gluesync-sdk-client': { settings },
      [path.resolve(__dirname, '../gluesyncSdkClient')]: {
        getGluesyncSdkClient: () => {
          if (sdkClientFails) {
            throw new Error('cannot create the SDK client');
          }
          return client;
        },
      },
      [path.resolve(__dirname, '../utils/logger')]: {
        getLogger: () => ({
          warn: (data: any, msg: string) => warns.push({ data, msg }),
        }),
      },
    },
  );
  const lines: Record<string, unknown>[] = [];
  const app = fastify({
    loggerInstance: pino(
      { level: 'info' },
      { write: (line: string) => lines.push(JSON.parse(line)) },
    ),
  });
  const messages = (): string[] => lines.map(l => String(l.msg));
  return { app, subject, settings, state, warns, lines, messages, client };
};

describe('gluesync plugin', () => {
  beforeEach(() => {
    envKeys.forEach(key => delete process.env[key]);
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
    mock.timers.reset();
    mock.restoreAll();
  });

  it('connects to CoreHub before the server listens and shuts the client down on close', async () => {
    process.env.GLUESYNC_MODULE_TAG = 'chronos';
    const { app, subject, settings, state, messages, client } = load({
      initialize: [true],
    });
    await app.register(fp(subject.default));
    await app.ready();
    assert.equal((app as any).gluesyncSdk, client);
    assert.equal(settings.moduleTag, 'chronos');
    assert.equal(state.initializeCalls, 1);
    assert.ok(
      messages().includes('Gluesync SDK client initialized successfully'),
    );
    assert.ok(messages().includes('CoreHub URL: https://hub:1717'));
    assert.ok(messages().includes('SDK token present: yes'));
    assert.ok(
      messages().includes(
        'License file path: /opt/gluesync/data/gs-license.dat',
      ),
    );
    await app.close();
    assert.equal(state.shutdownCalls, 1);
    assert.ok(
      messages().includes('Gluesync SDK client connection closed successfully'),
    );
  });

  it('uses the default module tag', async () => {
    const { app, subject, settings } = load({ initialize: [true] });
    await app.register(fp(subject.default));
    await app.ready();
    assert.equal(settings.moduleTag, 'conductor');
    await app.close();
  });

  it('keeps the conductor up when CoreHub is down at startup and retries in the background', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { app, subject, state, warns, messages } = load({
      initialize: [false, false, true],
    });
    await app.register(fp(subject.default));
    await app.ready();
    assert.equal(state.initializeCalls, 1);
    assert.equal(warns.length, 1);
    assert.match(warns[0].msg, /CoreHub not reachable at startup/);
    assert.equal(warns[0].data.error.message, 'CoreHub unreachable');

    // First retry after 1s: fails again, next one is due in 2s.
    mock.timers.tick(999);
    assert.equal(state.initializeCalls, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(state.initializeCalls, 2);
    assert.equal(warns.length, 2);
    assert.equal(warns[1].data.attempt, 1);
    assert.equal(warns[1].data.nextRetryMs, 2000);
    assert.match(warns[1].msg, /still unreachable/);

    mock.timers.tick(1999);
    await flush();
    assert.equal(state.initializeCalls, 2);
    mock.timers.tick(1);
    await flush();
    assert.equal(state.initializeCalls, 3);
    assert.ok(
      messages().includes('Connected to CoreHub after 2 background attempt(s)'),
    );
    assert.ok(
      messages().includes('Gluesync SDK client initialized successfully'),
    );

    // Connected: nothing is scheduled any more.
    mock.timers.tick(60000);
    await flush();
    assert.equal(state.initializeCalls, 3);
    await app.close();
  });

  it('caps the background retry delay at 30 seconds', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { app, subject, state, warns } = load({
      initialize: Array.from({ length: 12 }, () => false),
    });
    await app.register(fp(subject.default));
    await app.ready();
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    await delays.reduce(async (previous, delay) => {
      await previous;
      mock.timers.tick(delay);
      await flush();
    }, Promise.resolve());
    assert.equal(state.initializeCalls, 1 + delays.length);
    assert.equal(warns.at(-1)?.data.nextRetryMs, 30000);
    await app.close();
  });

  it('stops retrying once the server is closed', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { app, subject, state } = load({ initialize: [false, true] });
    await app.register(fp(subject.default));
    await app.ready();
    await app.close();
    mock.timers.tick(5000);
    await flush();
    assert.equal(state.initializeCalls, 1);
  });

  it('does not schedule more work when it is closed while a retry is in flight', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const answer: { fail: () => void } = { fail: () => undefined };
    const inFlight = new Promise<boolean>(resolve => {
      answer.fail = () => resolve(false);
    });
    const { app, subject, state } = load({ initialize: [false, inFlight] });
    await app.register(fp(subject.default));
    await app.ready();
    mock.timers.tick(1000);
    await flush();
    assert.equal(state.initializeCalls, 2);
    await app.close();
    // The retry in flight fails after the close and schedules the next one,
    // which must notice that the server is gone.
    answer.fail();
    await flush();
    mock.timers.tick(5000);
    await flush();
    assert.equal(state.initializeCalls, 2);
  });

  describe('CoreHub that is slow to answer at startup', () => {
    // initialize() whose outcome the test decides: it can stay pending for
    // longer than Fastify's plugin timeout (UDP discovery does)
    const deferred = () => {
      const control: { ok: () => void; fail: () => void } = {
        ok: () => undefined,
        fail: () => undefined,
      };
      const promise = new Promise<boolean>((resolve, reject) => {
        control.ok = () => resolve(true);
        control.fail = () => reject(new Error('discovery gave up'));
      });
      return { promise, control };
    };

    it('registers within the startup wait when initialize() never resolves', async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      const { app, subject, state, messages } = load({
        initialize: [new Promise<boolean>(() => {})], // never settles
      });
      const registered = app.register(fp(subject.default)).ready();
      await flush();
      assert.equal(state.initializeCalls, 1);
      mock.timers.tick(4999);
      await flush();
      assert.ok(!messages().some(m => /not connected after/.test(m)));
      mock.timers.tick(1);
      await registered;
      assert.ok(messages().some(m => /not connected after 5000 ms/.test(m)));
      assert.ok(
        !messages().includes('Gluesync SDK client initialized successfully'),
      );

      // The attempt is still in flight: no second one is started behind it.
      mock.timers.tick(120000);
      await flush();
      assert.equal(state.initializeCalls, 1);
      await app.close();
    });

    it('connects once when initialize() resolves after the plugin timeout', async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      const late = deferred();
      const { app, subject, state, warns, messages } = load({
        initialize: [late.promise],
      });
      const registered = app.register(fp(subject.default)).ready();
      await flush();
      mock.timers.tick(5000);
      await registered;

      mock.timers.tick(10000);
      late.control.ok();
      await flush();
      assert.equal(
        messages().filter(
          m => m === 'Gluesync SDK client initialized successfully',
        ).length,
        1,
      );
      assert.ok(messages().includes('CoreHub URL: https://hub:1717'));
      assert.equal(warns.length, 0);

      mock.timers.tick(120000);
      await flush();
      assert.equal(state.initializeCalls, 1);
      await app.close();
    });

    it('keeps retrying in the background when initialize() rejects after the startup wait', async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      const late = deferred();
      const { app, subject, state, warns, messages } = load({
        initialize: [late.promise, true],
      });
      const registered = app.register(fp(subject.default)).ready();
      await flush();
      mock.timers.tick(5000);
      await registered;

      late.control.fail();
      await flush();
      assert.equal(warns.length, 1);
      assert.match(warns[0].msg, /CoreHub not reachable at startup/);
      assert.equal(warns[0].data.error.message, 'discovery gave up');

      mock.timers.tick(1000);
      await flush();
      assert.equal(state.initializeCalls, 2);
      assert.ok(
        messages().includes(
          'Connected to CoreHub after 1 background attempt(s)',
        ),
      );
      await app.close();
    });

    it('does not wait for the full startup wait when initialize() rejects at once', async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      const { app, subject, state, warns } = load({ initialize: [false] });
      // No tick: registration must not depend on the startup wait timer.
      await app.register(fp(subject.default)).ready();
      assert.equal(state.initializeCalls, 1);
      assert.equal(warns.length, 1);
      await app.close();
    });

    it('does not retry or log anything when closed while the startup attempt is in flight', async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      const late = deferred();
      const { app, subject, state, warns, messages } = load({
        initialize: [late.promise, true],
      });
      const registered = app.register(fp(subject.default)).ready();
      await flush();
      mock.timers.tick(5000);
      await registered;
      await app.close();

      late.control.fail();
      await flush();
      mock.timers.tick(120000);
      await flush();
      assert.equal(state.initializeCalls, 1);
      assert.equal(warns.length, 0);
      assert.ok(
        !messages().includes('Gluesync SDK client initialized successfully'),
      );
    });

    it('does not start a background retry while the startup attempt is still running', async () => {
      mock.timers.enable({ apis: ['setTimeout'] });
      const late = deferred();
      const { app, subject, state } = load({
        initialize: [late.promise, true],
      });
      const registered = app.register(fp(subject.default)).ready();
      await flush();
      mock.timers.tick(5000);
      await registered;
      mock.timers.tick(60000);
      await flush();
      assert.equal(state.initializeCalls, 1);
      late.control.ok();
      await flush();
      mock.timers.tick(60000);
      await flush();
      assert.equal(state.initializeCalls, 1);
      await app.close();
    });
  });

  it('still closes when the SDK client fails to shut down', async () => {
    const { app, subject, state, lines } = load({
      initialize: [true],
      shutdownFails: true,
    });
    await app.register(fp(subject.default));
    await app.ready();
    await app.close();
    assert.equal(state.shutdownCalls, 1);
    const failure = lines.find(l =>
      /Error closing Gluesync SDK client connection: shutdown failed/.test(
        String(l.msg),
      ),
    );
    assert.equal(failure?.level, 50);
  });

  it('fails the registration when the SDK client cannot even be created', async () => {
    mock.method(console, 'error', () => undefined);
    const { app, subject } = load({ initialize: [true] }, true);
    await assert.rejects(
      (async () => {
        await app.register(fp(subject.default));
        await app.ready();
      })(),
      /cannot create the SDK client/,
    );
    assert.equal((console.error as any).mock.callCount(), 1);
  });
});
