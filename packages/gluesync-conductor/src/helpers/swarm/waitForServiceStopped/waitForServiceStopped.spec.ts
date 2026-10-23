import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  FakeTask,
  buildTask,
} from '../../../testing/fakeSwarmDocker';
import waitForServiceStopped from './waitForServiceStopped';

const NAME = 'gs_core-hub';

const clock = () => {
  const state = { t: 0 };

  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => {
      state.t += ms;
    },
  };
};

const dockerShowing = (
  tasks: (t: number) => ReadonlyArray<FakeTask>,
  now: () => number,
) => fakeSwarmDocker({ tasks: () => tasks(now()) }).docker;

describe('waitForServiceStopped', () => {
  it('is done when no task exists', async () => {
    const { now, sleep } = clock();
    const docker = dockerShowing(() => [], now);

    assert.deepEqual(
      await waitForServiceStopped(docker, NAME, { now, sleep }),
      {
        ok: true,
      },
    );
  });

  it('waits for a task that is shutting down', async () => {
    const { state, now, sleep } = clock();
    const docker = dockerShowing(
      t => [
        buildTask('core-hub', {
          desired: 'shutdown',
          state: t < 3000 ? 'running' : 'shutdown',
        }),
      ],
      now,
    );

    assert.deepEqual(
      await waitForServiceStopped(docker, NAME, { now, sleep }),
      {
        ok: true,
      },
    );
    assert.equal(state.t, 3000);
  });

  it('gives up after the maximum wait', async () => {
    const { now, sleep } = clock();
    const docker = dockerShowing(
      () => [buildTask('core-hub', { desired: 'shutdown' })],
      now,
    );

    const result = await waitForServiceStopped(docker, NAME, {
      now,
      sleep,
      maxWaitMs: 5000,
    });

    assert.equal(result.ok, false);
    assert.match(
      result.ok ? '' : result.reason,
      /gs_core-hub still has 1 running task\(s\) after 5s/,
    );
  });
});
