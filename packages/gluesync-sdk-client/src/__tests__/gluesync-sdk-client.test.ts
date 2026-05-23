/**
 * Tests for the mid-session auto-reconnect feature (GSSD-983).
 *
 * Strategy
 * --------
 * - `gluesync-sdk` is replaced by the manual mock in `__mocks__/gluesync-sdk.ts`.
 * - The singleton is reset before every test by clearing `_instance`.
 * - Fake timers control `setTimeout` so reconnect scheduling is deterministic.
 */

import { GluesyncSDKClient } from '../gluesync-sdk-client';
import { GluesyncClient, latestMockInstance } from '../__mocks__/gluesync-sdk';

// The jest moduleNameMapper points 'gluesync-sdk' at our manual mock, so this
// import resolves to the mock module above.

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Reset the singleton so every test starts fresh. */
function resetSingleton(): void {
  (GluesyncSDKClient as unknown as Record<string, unknown>)._instance =
    undefined;
}

/** Return the singleton (fresh each test after resetSingleton()). */
function getInstance(autoReconnect = true): GluesyncSDKClient {
  return GluesyncSDKClient.getInstance(undefined, autoReconnect);
}

// ─── test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  resetSingleton();
  // Point at a fake CoreHub host so initialize() uses the host+port path
  // (not UDP discovery, which retries indefinitely).
  process.env.GLUESYNC_HOST = 'http://mock-corehub:1717';
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
  delete process.env.GLUESYNC_HOST;
});

// ─── test 1: disconnect after init → reconnect is scheduled ──────────────────

describe('auto-reconnect after unexpected disconnect', () => {
  it('schedules a reconnect when disconnected without intentional close', async () => {
    const client = getInstance();

    // 1) Initialize successfully
    await client.initialize();
    expect(client.isInitialized).toBe(true);

    // Capture the mock SDK instance that was wired up during init
    const sdkInstance = latestMockInstance;

    // 2) Simulate a surprise disconnect from core-hub
    sdkInstance.simulateEvent('disconnected', 'core-hub restarted');

    // SDK state should be torn down
    expect(client.isInitialized).toBe(false);
    expect(client.token).toBeNull();

    // A reconnect timer should now be pending (fake timers haven't fired yet)
    const pendingTimers = jest.getTimerCount();
    expect(pendingTimers).toBeGreaterThan(0);

    // 3) Advance time past the maximum possible first-attempt delay (jitter: up to 1.5 × 1000 ms)
    await jest.advanceTimersByTimeAsync(2_000);

    // A new GluesyncClient should have been constructed for the reconnect attempt
    expect(GluesyncClient).toHaveBeenCalledTimes(2); // 1st init + 1 reconnect
    expect(client.isInitialized).toBe(true);
  });
});

// ─── test 2: shutdown() → no reconnect ───────────────────────────────────────

describe('no reconnect after intentional shutdown', () => {
  it('does NOT schedule a reconnect when shutdown() precedes disconnect', async () => {
    const client = getInstance();

    await client.initialize();
    expect(client.isInitialized).toBe(true);

    const sdkInstance = latestMockInstance;

    // Make disconnect() synchronously trigger the 'disconnected' event AFTER
    // we already called shutdown() (which sets _intentionalClose = true).
    sdkInstance.disconnect.mockImplementationOnce(() => {
      sdkInstance.simulateEvent('disconnected', 'clean shutdown');
      return Promise.resolve();
    });

    // 1) Explicit shutdown
    await client.shutdown();

    // 2) No reconnect timer should be pending
    expect(jest.getTimerCount()).toBe(0);

    // 3) Advancing time confirms nothing reconnects
    await jest.advanceTimersByTimeAsync(60_000);
    expect(GluesyncClient).toHaveBeenCalledTimes(1); // only the original init
    expect(client.isInitialized).toBe(false);
  });
});

// ─── test 3: 3 failures → 4th succeeds → 'reconnected' emitted ───────────────

describe('reconnected event after transient failures', () => {
  it('fires "reconnected" event after 3 failed attempts and a successful 4th', async () => {
    const client = getInstance();
    const reconnectedHandler = jest.fn();
    client.on('reconnected', reconnectedHandler);

    // ── initial successful connect ──────────────────────────────────────────
    await client.initialize();
    expect(client.isInitialized).toBe(true);

    // ── configure: first 3 connect() calls fail, 4th succeeds ──────────────
    let connectCallCount = 0;
    // We intercept at the GluesyncClient constructor level so each new instance
    // created during reconnect gets the correct behaviour.
    (GluesyncClient as jest.Mock).mockImplementation(() => {
      connectCallCount += 1;
      const instance = {
        connect: jest.fn().mockImplementation(() => {
          if (connectCallCount <= 3) {
            return Promise.reject(new Error('ECONNREFUSED'));
          }
          // 4th call: fire 'connected' then resolve (normal SDK behaviour)
          (instance._handlers['connected'] ?? []).forEach((h: CallableFunction) =>
            h('mock-token-v2'),
          );
          return Promise.resolve();
        }),
        disconnect: jest.fn().mockResolvedValue(undefined),
        on: jest.fn().mockImplementation((event: string, handler: unknown) => {
          if (!instance._handlers[event]) {
            instance._handlers[event] = [];
          }
          (instance._handlers[event] as unknown[]).push(handler);
        }),
        _handlers: {} as Record<string, CallableFunction[]>,
        host: 'mock-corehub',
        port: 1717,
        useSSL: false,
        isConnected: false,
      };
      return instance;
    });

    // ── trigger disconnect to start the reconnect loop ─────────────────────
    latestMockInstance.simulateEvent('disconnected', 'core-hub crash');

    // ── drive the reconnect loop through 4 attempts ────────────────────────
    // Each attempt's delay is at most 1.5 × min(60_000, 1000 × 2^attempt).
    // Attempt 0 → max 1500 ms; 1 → max 3000 ms; 2 → max 6000 ms; 3 → max 12000 ms
    // Advance well past the worst-case accumulated delay.
    for (let i = 0; i < 4; i++) {
      // Run any currently-queued micro-tasks (promise resolutions)
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(15_000);
    }
    // Flush final micro-tasks after the last timer tick
    await Promise.resolve();
    await Promise.resolve();

    // ── assertions ─────────────────────────────────────────────────────────
    // connectCallCount === 4: 3 failures + 1 success
    expect(connectCallCount).toBe(4);
    expect(client.isInitialized).toBe(true);
    expect(reconnectedHandler).toHaveBeenCalledTimes(1);
  });
});
