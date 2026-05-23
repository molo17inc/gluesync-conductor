/**
 * Manual mock for gluesync-sdk used in Jest tests.
 * Each test suite can override `connect` behaviour via `mockConnectImpl`.
 */

type EventHandler = (...args: unknown[]) => void;

export class MockGluesyncClientInstance {
  private readonly _handlers: Record<string, EventHandler[]> = {};

  /** Replaced per-test to control connection success/failure. */
  public connect: jest.Mock = jest.fn().mockImplementation(() => {
    // Simulate the SDK firing 'connected' before resolving
    (this._handlers['connected'] ?? []).forEach(h => h('mock-token'));
    return Promise.resolve();
  });

  public disconnect: jest.Mock = jest.fn().mockResolvedValue(undefined);

  public on: jest.Mock = jest.fn().mockImplementation(
    (event: string, handler: EventHandler) => {
      if (!this._handlers[event]) {
        this._handlers[event] = [];
      }
      this._handlers[event].push(handler);
    },
  );

  /** Test helper: trigger an event as if the SDK emitted it. */
  public simulateEvent(event: string, ...args: unknown[]): void {
    (this._handlers[event] ?? []).forEach(h => h(...args));
  }

  public host = 'mock-corehub';
  public port = 1717;
  public useSSL = false;
  public isConnected = true;
}

/** The most recently constructed mock instance (reset on each `new GluesyncClient()`). */
export let latestMockInstance: MockGluesyncClientInstance;

export const GluesyncClient = jest
  .fn()
  .mockImplementation(() => {
    latestMockInstance = new MockGluesyncClientInstance();
    return latestMockInstance;
  });

export class GluesyncConnectionError extends Error {}
export class GluesyncLicenseError extends Error {}
export class GluesyncAuthenticationError extends Error {}
