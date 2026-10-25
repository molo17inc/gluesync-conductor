import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';
import type { RetryOnDockerOutage } from './retryOnDockerOutage.model';

const here = (p: string): string => path.resolve(__dirname, p);

const refused = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

const load = (waitFails?: Error) => {
  const waits: string[] = [];
  const retry = loadWithStubs<{ default: RetryOnDockerOutage }>(
    here('./retryOnDockerOutage'),
    {
      [here('../../dockerode/waitForDockerOutage/waitForDockerOutage')]: {
        default: async () => {
          waits.push('wait');
          if (waitFails) {
            throw waitFails;
          }
        },
      },
      [here('../../../utils/logger')]: {
        getLogger: () => ({ warn: () => undefined }),
      },
    },
  ).default;

  return { retry, waits };
};

const docker = {} as never;

// Fails with these errors in turn, then answers
const flaky = (errors: ReadonlyArray<Error>) => {
  const state = { calls: 0 };

  return {
    state,
    call: async (): Promise<string> => {
      const error = errors[state.calls];
      state.calls += 1;
      if (error) {
        throw error;
      }

      return 'done';
    },
  };
};

describe('retryOnDockerOutage', () => {
  it('returns what the call returns', async () => {
    const { retry, waits } = load();
    const { call, state } = flaky([]);

    assert.equal(await retry(docker, 'x', call), 'done');
    assert.equal(state.calls, 1);
    assert.deepEqual(waits, []);
  });

  it('waits for Docker and tries again after a dropped connection', async () => {
    const { retry, waits } = load();
    const { call, state } = flaky([refused(), refused()]);

    assert.equal(await retry(docker, 'x', call), 'done');
    assert.equal(state.calls, 3);
    assert.equal(waits.length, 2);
  });

  it('does not retry a real error', async () => {
    const { retry, waits } = load();
    const { call, state } = flaky([new Error('no such image')]);

    await assert.rejects(retry(docker, 'x', call), /no such image/);
    assert.equal(state.calls, 1);
    assert.deepEqual(waits, []);
  });

  it('gives up when the outage outlasts the attempts', async () => {
    const { retry } = load();
    const { call, state } = flaky(Array.from({ length: 5 }, refused));

    await assert.rejects(retry(docker, 'x', call), /ECONNREFUSED/);
    assert.equal(state.calls, 3);
  });

  it('fails with the wait when Docker does not come back', async () => {
    const { retry } = load(new Error('Docker daemon not ready within 60000ms'));
    const { call, state } = flaky([refused()]);

    await assert.rejects(retry(docker, 'x', call), /not ready within 60000ms/);
    assert.equal(state.calls, 1);
  });
});
