import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
});
