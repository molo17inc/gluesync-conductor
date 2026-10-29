import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import fakeSwarmDocker, {
  FakeService,
  FakeTask,
  buildService,
  buildTask,
} from '../../../testing/fakeSwarmDocker';
import waitForServiceConverged from './waitForServiceConverged';

const NAME = 'gs_core-hub';
const options = { windowMs: 20_000, maxWaitMs: 60_000, pollMs: 2_000 };

// Time only moves when the code sleeps, so the "20 seconds" take no time
const clock = () => {
  const state = { t: 0, sleeps: 0 };

  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => {
      state.t += ms;
      state.sleeps += 1;
    },
  };
};

type Scene = Readonly<{ service: FakeService; tasks: ReadonlyArray<FakeTask> }>;

// What the swarm shows at a given time
const dockerShowing = (scene: (t: number) => Scene, now: () => number) =>
  fakeSwarmDocker({
    services: () => [scene(now()).service],
    tasks: () => scene(now()).tasks,
  }).docker;

const healthy: Scene = {
  service: buildService('core-hub', { state: 'completed' }),
  tasks: [buildTask('core-hub')],
};

const envSaved = process.env.UPDATE_VERIFY_SECONDS;

afterEach(() => {
  if (envSaved === undefined) {
    delete process.env.UPDATE_VERIFY_SECONDS;
  } else {
    process.env.UPDATE_VERIFY_SECONDS = envSaved;
  }
});

describe('waitForServiceConverged', () => {
  it('passes once the service stayed converged for the window', async () => {
    const { state, now, sleep } = clock();
    const docker = dockerShowing(() => healthy, now);

    const result = await waitForServiceConverged(docker, NAME, {
      ...options,
      now,
      sleep,
    });

    assert.deepEqual(result, { ok: true });
    assert.ok(state.t >= 20_000, `waited ${state.t}ms`);
    assert.ok(state.t < 30_000, `waited ${state.t}ms`);
  });

  it('accepts a service that was never updated (no update status)', async () => {
    const { now, sleep } = clock();
    const docker = dockerShowing(
      () => ({
        service: buildService('core-hub'),
        tasks: [buildTask('core-hub')],
      }),
      now,
    );

    assert.deepEqual(
      await waitForServiceConverged(docker, NAME, { ...options, now, sleep }),
      { ok: true },
    );
  });

  it('waits for the update to complete, then for the window', async () => {
    const { state, now, sleep } = clock();
    const docker = dockerShowing(
      t => ({
        service: buildService('core-hub', {
          state: t < 10_000 ? 'updating' : 'completed',
        }),
        tasks: [buildTask('core-hub')],
      }),
      now,
    );

    const result = await waitForServiceConverged(docker, NAME, {
      ...options,
      now,
      sleep,
    });

    assert.deepEqual(result, { ok: true });
    assert.ok(state.t >= 30_000, `waited ${state.t}ms`);
  });

  it('restarts the window when the service stops being converged', async () => {
    const { state, now, sleep } = clock();
    const docker = dockerShowing(
      t => ({
        service: healthy.service,
        tasks: t >= 10_000 && t < 14_000 ? [] : healthy.tasks,
      }),
      now,
    );

    const result = await waitForServiceConverged(docker, NAME, {
      ...options,
      now,
      sleep,
    });

    assert.deepEqual(result, { ok: true });
    // Converged again at 14s: 20s more
    assert.ok(state.t >= 34_000, `waited ${state.t}ms`);
  });

  [
    'rollback_started',
    'rollback_completed',
    'rollback_paused',
    'paused',
  ].forEach(updateState => {
    it(`fails at once on ${updateState}`, async () => {
      const { state, now, sleep } = clock();
      const docker = dockerShowing(
        () => ({
          service: buildService('core-hub', {
            state: updateState,
            message: 'update rolled back',
          }),
          tasks: [buildTask('core-hub')],
        }),
        now,
      );

      const result = await waitForServiceConverged(docker, NAME, {
        ...options,
        now,
        sleep,
      });

      assert.equal(result.ok, false);
      assert.match(
        (result as { reason: string }).reason,
        new RegExp(`gs_core-hub update ${updateState}: update rolled back`),
      );
      assert.equal(state.sleeps, 0);
    });
  });

  it('says why the last task failed', async () => {
    const { now, sleep } = clock();
    const docker = dockerShowing(
      () => ({
        service: buildService('core-hub', { state: 'rollback_completed' }),
        tasks: [
          buildTask('core-hub', {
            taskId: 'bad',
            desired: 'shutdown',
            state: 'rejected',
            err: 'No such image: molo17/nope:1',
          }),
        ],
      }),
      now,
    );

    const result = await waitForServiceConverged(docker, NAME, {
      ...options,
      now,
      sleep,
    });

    assert.match(
      (result as { reason: string }).reason,
      /last task rejected: No such image: molo17\/nope:1/,
    );
  });

  it('fails with the state it was stuck in when time runs out', async () => {
    const { state, now, sleep } = clock();
    const docker = dockerShowing(
      () => ({
        service: buildService('core-hub', { replicas: 2 }),
        tasks: [
          buildTask('core-hub', { taskId: 'a' }),
          buildTask('core-hub', { taskId: 'b', state: 'starting' }),
        ],
      }),
      now,
    );

    const result = await waitForServiceConverged(docker, NAME, {
      ...options,
      now,
      sleep,
    });

    assert.equal(result.ok, false);
    assert.match(
      (result as { reason: string }).reason,
      /gs_core-hub did not converge within 60s \(update none, 1\/2 tasks running\)/,
    );
    assert.ok(state.t >= 60_000);
  });

  it('does not count tasks of the old spec', async () => {
    const { now, sleep } = clock();
    // The update call was made, Swarm has not touched the tasks yet
    const docker = dockerShowing(
      () => ({
        service: buildService('core-hub', {
          image: 'molo17/gluesync-core-hub:2.3.1',
        }),
        tasks: [buildTask('core-hub')],
      }),
      now,
    );

    const result = await waitForServiceConverged(docker, NAME, {
      ...options,
      now,
      sleep,
    });

    assert.equal(result.ok, false);
  });

  it('does not count tasks from before a forced update', async () => {
    const { now, sleep } = clock();
    const docker = dockerShowing(
      t => ({
        service: buildService('core-hub', { forceUpdate: 2 }),
        tasks: [buildTask('core-hub', { forceUpdate: t < 8_000 ? 1 : 2 })],
      }),
      now,
    );

    const result = await waitForServiceConverged(docker, NAME, {
      ...options,
      now,
      sleep,
    });

    assert.deepEqual(result, { ok: true });
  });

  it('waits while a start-first update runs more tasks than wanted', async () => {
    const { state, now, sleep } = clock();
    const docker = dockerShowing(
      t => ({
        service: buildService('core-hub', { state: 'completed' }),
        tasks:
          t < 6_000
            ? [
                buildTask('core-hub', { taskId: 'old' }),
                buildTask('core-hub', { taskId: 'new', state: 'starting' }),
              ]
            : [buildTask('core-hub', { taskId: 'new' })],
      }),
      now,
    );

    const result = await waitForServiceConverged(docker, NAME, {
      ...options,
      now,
      sleep,
    });

    assert.deepEqual(result, { ok: true });
    assert.ok(state.t >= 26_000, `waited ${state.t}ms`);
  });

  it('is converged at zero replicas with no tasks (a stopped service)', async () => {
    const { now, sleep } = clock();
    const docker = dockerShowing(
      () => ({
        service: buildService('core-hub', { replicas: 0 }),
        tasks: [],
      }),
      now,
    );

    assert.deepEqual(
      await waitForServiceConverged(docker, NAME, { ...options, now, sleep }),
      { ok: true },
    );
  });

  it('is not converged at zero replicas while a task is still shutting down', async () => {
    const { now, sleep } = clock();
    const docker = dockerShowing(
      () => ({
        service: buildService('core-hub', { replicas: 0 }),
        tasks: [buildTask('core-hub')],
      }),
      now,
    );

    assert.equal(
      (await waitForServiceConverged(docker, NAME, { ...options, now, sleep }))
        .ok,
      false,
    );
  });

  describe('global service', () => {
    it('needs every task running, and at least one', async () => {
      const { now, sleep } = clock();
      const global = buildService('core-hub', { global: true });

      assert.deepEqual(
        await waitForServiceConverged(
          dockerShowing(
            () => ({
              service: global,
              tasks: [
                buildTask('core-hub', { taskId: 'a' }),
                buildTask('core-hub', { taskId: 'b', nodeId: 'node-2' }),
              ],
            }),
            now,
          ),
          NAME,
          { ...options, now, sleep },
        ),
        { ok: true },
      );

      assert.equal(
        (
          await waitForServiceConverged(
            dockerShowing(() => ({ service: global, tasks: [] }), now),
            NAME,
            { ...options, now, sleep },
          )
        ).ok,
        false,
      );
    });
  });

  it('fails at once when the service does not exist', async () => {
    const { state, now, sleep } = clock();
    const { docker } = fakeSwarmDocker();

    const result = await waitForServiceConverged(docker, 'gs_ghost', {
      ...options,
      now,
      sleep,
    });

    assert.deepEqual(result, { ok: false, reason: 'gs_ghost does not exist' });
    assert.equal(state.sleeps, 0);
  });

  it('keeps trying through a Docker error', async () => {
    const { now, sleep } = clock();
    const failing = new Set([0, 2_000]);
    const { docker } = fakeSwarmDocker({
      services: () => {
        if (failing.has(now())) {
          throw new Error('connection refused');
        }
        return [healthy.service];
      },
      tasks: healthy.tasks,
    });

    assert.deepEqual(
      await waitForServiceConverged(docker, NAME, { ...options, now, sleep }),
      { ok: true },
    );
  });

  it('reports a Docker error that never goes away', async () => {
    const { now, sleep } = clock();
    const { docker } = fakeSwarmDocker({
      services: () => {
        throw new Error('connection refused');
      },
    });

    const result = await waitForServiceConverged(docker, NAME, {
      ...options,
      now,
      sleep,
    });

    assert.match(
      (result as { reason: string }).reason,
      /did not converge within 60s \(Docker error: connection refused\)/,
    );
  });

  it('waits for Docker through a dropped connection and fails when it does not come back', async () => {
    const { now, sleep } = clock();
    const waits: string[] = [];
    const { docker } = fakeSwarmDocker({
      services: () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        });
      },
    });

    const result = await waitForServiceConverged(docker, NAME, {
      ...options,
      now,
      sleep,
      waitForDocker: async () => {
        waits.push('wait');
        throw new Error('Docker daemon not ready within 60000ms');
      },
    });

    assert.deepEqual(waits, ['wait']);
    assert.match(
      (result as { reason: string }).reason,
      /Docker is not reachable: Docker daemon not ready within 60000ms/,
    );
  });

  it('does not wait for the window when UPDATE_VERIFY_SECONDS is 0', async () => {
    process.env.UPDATE_VERIFY_SECONDS = '0';
    const { state, now, sleep } = clock();
    const docker = dockerShowing(() => healthy, now);

    assert.deepEqual(
      await waitForServiceConverged(docker, NAME, { now, sleep }),
      { ok: true },
    );
    assert.equal(state.sleeps, 0);
  });

  it('uses the verify window from the environment', async () => {
    process.env.UPDATE_VERIFY_SECONDS = '6';
    const { state, now, sleep } = clock();
    const docker = dockerShowing(() => healthy, now);

    await waitForServiceConverged(docker, NAME, { now, sleep });

    assert.equal(state.t, 6_000);
  });

  describe('while Swarm pulls the new image', () => {
    // The new task is `preparing` (pulling) until pulledAt, then runs
    const pullingUntil =
      (pulledAt: number, extra: Parameters<typeof buildTask>[1] = {}) =>
      (t: number): Scene => ({
        service: buildService('core-hub', {
          state: t < pulledAt ? 'updating' : 'completed',
        }),
        tasks: [
          buildTask('core-hub', {
            state: t < pulledAt ? 'preparing' : 'running',
            ...extra,
          }),
        ],
      });

    it('does not count the pull against the converge time', async () => {
      const { state, now, sleep } = clock();
      // A 90 s pull, longer than the 60 s maxWait of these options
      const docker = dockerShowing(pullingUntil(90_000), now);

      const result = await waitForServiceConverged(docker, NAME, {
        ...options,
        now,
        sleep,
      });

      assert.deepEqual(result, { ok: true });
      assert.ok(state.t >= 110_000, `waited ${state.t}ms`);
    });

    it('fails a pull that takes longer than the pull limit', async () => {
      const { state, now, sleep } = clock();
      const docker = dockerShowing(pullingUntil(Number.POSITIVE_INFINITY), now);

      const result = await waitForServiceConverged(docker, NAME, {
        ...options,
        maxPullMs: 300_000,
        now,
        sleep,
      });

      assert.equal(result.ok, false);
      assert.match(
        (result as { reason: string }).reason,
        /gs_core-hub image pull did not finish within 300s/,
      );
      assert.ok(state.t >= 300_000, `waited ${state.t}ms`);
      assert.ok(state.t < 310_000, `waited ${state.t}ms`);
    });

    it('still counts a task that cannot be scheduled (pending)', async () => {
      const { state, now, sleep } = clock();
      const docker = dockerShowing(
        () => ({
          service: buildService('core-hub', { state: 'updating' }),
          tasks: [buildTask('core-hub', { state: 'pending' })],
        }),
        now,
      );

      const result = await waitForServiceConverged(docker, NAME, {
        ...options,
        now,
        sleep,
      });

      assert.equal(result.ok, false);
      assert.match(
        (result as { reason: string }).reason,
        /did not converge within 60s/,
      );
      assert.ok(state.t < 70_000, `waited ${state.t}ms`);
    });

    it('counts a preparing task that reports an error', async () => {
      const { state, now, sleep } = clock();
      const docker = dockerShowing(
        pullingUntil(Number.POSITIVE_INFINITY, {
          err: 'No such image: molo17/gluesync-core-hub:2.3.0',
        }),
        now,
      );

      const result = await waitForServiceConverged(docker, NAME, {
        ...options,
        now,
        sleep,
      });

      assert.equal(result.ok, false);
      assert.match(
        (result as { reason: string }).reason,
        /did not converge within 60s/,
      );
      assert.ok(state.t < 70_000, `waited ${state.t}ms`);
    });

    it('only pauses the clock for a task of the current spec', async () => {
      const { state, now, sleep } = clock();
      // An old-spec task still pulling says nothing about the new version
      const docker = dockerShowing(
        () => ({
          service: buildService('core-hub', {
            image: 'molo17/gluesync-core-hub:2.3.1',
            state: 'updating',
          }),
          tasks: [buildTask('core-hub', { state: 'preparing' })],
        }),
        now,
      );

      const result = await waitForServiceConverged(docker, NAME, {
        ...options,
        now,
        sleep,
      });

      assert.equal(result.ok, false);
      assert.ok(state.t < 70_000, `waited ${state.t}ms`);
    });
  });
});
