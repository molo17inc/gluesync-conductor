import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { Logger } from 'pino';

import { retryCmd, retryDelayMs } from './retryHelper';

afterEach(() => {
  mock.timers.reset();
});

const logger = { warn: () => undefined } as unknown as Logger;
const transient = Object.assign(new Error('connect ECONNREFUSED'), {
  code: 'ECONNREFUSED',
});

describe('retryDelayMs', () => {
  it('doubles from one second', () => {
    assert.deepEqual([1, 2, 3, 4].map(retryDelayMs), [1000, 2000, 4000, 8000]);
  });
});

describe('retryCmd', () => {
  it('waits a second after the first transient failure, not minutes', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const attempts: number[] = [];
    const result = retryCmd(
      1,
      3,
      async () => {
        attempts.push(attempts.length);
        if (attempts.length < 3) {
          throw transient;
        }
        return { exitCode: 0, out: 'ok', err: '' };
      },
      logger,
    );

    await new Promise(resolve => {
      setImmediate(resolve);
    });
    assert.equal(attempts.length, 1);
    mock.timers.tick(1000);
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    assert.equal(attempts.length, 2);
    mock.timers.tick(2000);

    assert.equal((await result).out, 'ok');
    assert.equal(attempts.length, 3);
  });

  it('does not retry an error that is not transient', async () => {
    const attempts: number[] = [];

    await assert.rejects(
      retryCmd(
        1,
        3,
        async () => {
          attempts.push(1);
          throw new Error('boom');
        },
        logger,
      ),
      /boom/,
    );
    assert.equal(attempts.length, 1);
  });
});
