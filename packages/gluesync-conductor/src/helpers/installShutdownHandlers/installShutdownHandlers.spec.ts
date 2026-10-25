import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import installShutdownHandlers from './installShutdownHandlers';
import { ShutdownSignal } from './installShutdownHandlers.model';

type Handler = (signal: ShutdownSignal) => void;

const harness = (close: () => Promise<unknown>, timeoutMs = 50) => {
  const handlers = new Map<ShutdownSignal, Handler>();
  const exits: number[] = [];
  const closes: number[] = [];
  const server = {
    close: () => {
      closes.push(Date.now());
      return close();
    },
  };

  const shutdown = installShutdownHandlers(
    server,
    code => {
      exits.push(code);
    },
    {
      timeoutMs,
      subscribe: (signal, handler) => {
        handlers.set(signal, handler);
      },
    },
  );

  return { handlers, exits, closes, shutdown };
};

const settle = (): Promise<void> =>
  new Promise(resolve => {
    setImmediate(resolve);
  });

describe('installShutdownHandlers', () => {
  it('listens to SIGTERM and SIGINT', () => {
    const { handlers } = harness(async () => undefined);

    assert.deepEqual([...handlers.keys()].sort(), ['SIGINT', 'SIGTERM']);
  });

  it('closes the server and exits 0 on SIGTERM', async () => {
    const { handlers, exits, closes } = harness(async () => undefined);

    handlers.get('SIGTERM')?.('SIGTERM');
    await settle();

    assert.equal(closes.length, 1);
    assert.deepEqual(exits, [0]);
  });

  it('does the same on SIGINT', async () => {
    const { handlers, exits, closes } = harness(async () => undefined);

    handlers.get('SIGINT')?.('SIGINT');
    await settle();

    assert.equal(closes.length, 1);
    assert.deepEqual(exits, [0]);
  });

  it('runs once however many signals arrive', async () => {
    const { exits, closes, shutdown } = harness(
      () =>
        new Promise(resolve => {
          setTimeout(resolve, 10);
        }),
    );

    await Promise.all([
      shutdown('SIGTERM'),
      shutdown('SIGINT'),
      shutdown('SIGTERM'),
    ]);
    await shutdown('SIGTERM');

    assert.equal(closes.length, 1);
    assert.deepEqual(exits, [0]);
  });

  it('exits 0 when the server does not close within the timeout', async () => {
    const { exits, shutdown } = harness(
      () =>
        new Promise(() => {
          // never settles
        }),
      20,
    );

    const started = Date.now();
    await shutdown('SIGTERM');

    assert.deepEqual(exits, [0]);
    assert.ok(Date.now() - started >= 15);
  });

  it('exits 1 when closing the server fails', async () => {
    const { exits, shutdown } = harness(async () => {
      throw new Error('boom');
    });

    await shutdown('SIGTERM');

    assert.deepEqual(exits, [1]);
  });
});
