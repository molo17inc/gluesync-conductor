import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type Docker from 'dockerode';
import type { Logger } from 'pino';

import waitForDockerDaemon from './waitForDockerDaemon';

const quietLog = { warn: () => {}, debug: () => {} } as unknown as Logger;

const dockerAnsweringOnPing = (
  n: number,
): { docker: Docker; calls: () => number } => {
  const calls = new Map<string, number>([['n', 0]]);
  const docker = {
    ping: () => {
      calls.set('n', (calls.get('n') ?? 0) + 1);
      // Earlier pings never answer: a slow daemon, not a refused connection.
      return (calls.get('n') ?? 0) >= n
        ? Promise.resolve('OK')
        : new Promise(() => {});
    },
  } as unknown as Docker;
  return { docker, calls: () => calls.get('n') ?? 0 };
};

describe('waitForDockerDaemon', () => {
  it('retries a ping that times out instead of giving up on the first one', async () => {
    const { docker, calls } = dockerAnsweringOnPing(3);
    await waitForDockerDaemon(docker, quietLog, {
      totalTimeoutMs: 2000,
      perAttemptTimeoutMs: 30,
      baseDelayMs: 5,
      maxDelayMs: 10,
    });
    assert.equal(calls(), 3);
  });

  it('gives up after the total budget with a transient error', async () => {
    const { docker } = dockerAnsweringOnPing(1000);
    await assert.rejects(
      waitForDockerDaemon(docker, quietLog, {
        totalTimeoutMs: 150,
        perAttemptTimeoutMs: 20,
        baseDelayMs: 5,
        maxDelayMs: 10,
      }),
      (error: Readonly<Error & { code?: string }>) =>
        /not ready within/.test(error.message) && error.code === 'ETIMEDOUT',
    );
  });

  it('fails at once on an error that is not transient', async () => {
    const docker = {
      ping: async () => {
        throw new Error('permission denied');
      },
    } as unknown as Docker;
    await assert.rejects(
      waitForDockerDaemon(docker, quietLog, { totalTimeoutMs: 2000 }),
      /permission denied/,
    );
  });

  describe('when the budget runs out during a failing ping', () => {
    afterEach(() => {
      mock.timers.reset();
    });

    it('gives up with a transient error instead of sleeping', async () => {
      mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
      const docker = {
        ping: () => {
          // The refused connection takes the whole budget.
          mock.timers.tick(200);
          return Promise.reject(
            Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
          );
        },
      } as unknown as Docker;
      await assert.rejects(
        waitForDockerDaemon(docker, quietLog, { totalTimeoutMs: 200 }),
        (error: Readonly<Error & { code?: string }>) =>
          /not ready within 200ms/.test(error.message) &&
          error.code === 'ETIMEDOUT',
      );
    });
  });
});
