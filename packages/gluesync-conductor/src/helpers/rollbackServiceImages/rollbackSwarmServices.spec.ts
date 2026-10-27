import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import fakeSwarmDocker, {
  buildService,
  buildTask,
} from '../../testing/fakeSwarmDocker';
import loadWithStubs from '../../testing/loadWithStubs';
import type { SwarmRestore } from '../swarm/swarmRestore/swarmRestore.model';
import type { RollbackServiceImages } from './rollbackServiceImages.model';

const here = (p: string): string => path.resolve(__dirname, p);

afterEach(() => {
  delete process.env.CONDUCTOR_DOCKER_WAIT_MS;
  delete process.env.UPDATE_VERIFY_MAX_WAIT_SECONDS;
});

type State = Record<
  string,
  {
    image: string;
    version: number;
    up: boolean;
    labels?: Record<string, string>;
  }
>;

// A swarm that keeps what the API writes: an image update bumps the version and
// the tasks of the new image run (unless `stuck` says they never come up).
const world = (
  initial: State,
  extra: Readonly<{
    pingDown?: boolean;
    updateFails?: ReadonlySet<string>;
  }> = {},
) => {
  const state: State = structuredClone(initial);
  const { docker, calls } = fakeSwarmDocker({
    pingDown: extra.pingDown,
    services: () =>
      Object.entries(state).map(([id, s]) =>
        buildService(id, {
          image: s.image,
          version: s.version,
          labels: s.labels,
        }),
      ),
    tasks: () =>
      Object.entries(state)
        .filter(([, s]) => s.up)
        .map(([id, s]) => buildTask(id, { image: s.image })),
  });
  const original = docker.getService.bind(docker);
  // eslint-disable-next-line no-param-reassign
  (docker as any).getService = (name: string) => {
    const service = original(name);
    const id = name.replace(/^gs_/, '');

    return {
      ...service,
      update: async (options: Record<string, any>) => {
        if (extra.updateFails?.has(id)) {
          throw new Error(`cannot update ${id}`);
        }
        await service.update(options);
        // eslint-disable-next-line no-underscore-dangle -- dockerode's body
        const { Labels: labels, TaskTemplate } = options._body;
        const image = TaskTemplate.ContainerSpec.Image;
        state[id] = { image, version: state[id].version + 1, up: true, labels };
      },
    };
  };

  return { docker: docker as Docker, calls, state };
};

const load = () => {
  const file = {
    current: {
      version: '3',
      services: {
        a: { image: 'a:2' },
        b: { image: 'b:2' },
      },
    } as Record<string, any>,
  };
  const swarmRestore = loadWithStubs<{ default: SwarmRestore }>(
    here('../swarm/swarmRestore/swarmRestore'),
    {
      [here('../composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => file.current,
      },
    },
  ).default;
  const rollback = loadWithStubs<{ default: RollbackServiceImages }>(
    here('./rollbackServiceImages'),
    {
      [here('../composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => file.current,
      },
      [here('../composeFile/writeComposeFile/writeComposeFile')]: {
        default: async (compose: typeof file.current) => {
          file.current = compose;
        },
      },
      [here('../dockerode/createActions/createActions')]: {
        runCmd: async () => {
          throw new Error('compose must not be used on swarm');
        },
      },
      [here('../swarm/swarmRestore/swarmRestore')]: { default: swarmRestore },
    },
  ).default;

  return { rollback, file };
};

const rollbacks = [
  { id: 'a', image: 'a:1' },
  { id: 'b', image: 'b:1' },
];

const restore = (docker: Docker, before: Record<string, string>) => ({
  recreate: true as const,
  docker,
  before,
  services: ['a', 'b'],
  swarm: { namespace: 'gs' },
});

describe('rollbackServiceImages on Swarm', () => {
  it('puts back the service the failed update changed and leaves the rest alone', async () => {
    process.env.UPDATE_VERIFY_MAX_WAIT_SECONDS = '0';
    // The update changed `a` (version 8, new image) and never reached `b`
    const { docker, calls, state } = world({
      a: { image: 'a:2', version: 8, up: false },
      b: { image: 'b:1', version: 7, up: true },
    });
    const { rollback, file } = load();

    const outcomes = await rollback(
      rollbacks,
      restore(docker, { a: '7@a:1', b: '7@b:1' }),
    );

    assert.deepEqual(outcomes, [
      { id: 'a', image: 'a:1', ok: true },
      { id: 'b', image: 'b:1', ok: true, untouched: true },
    ]);
    assert.deepEqual(file.current.services, {
      a: { image: 'a:1' },
      b: { image: 'b:1' },
    });
    assert.deepEqual(
      calls.updates.map(u => u.id),
      ['gs_a', 'gs_a'],
      'only the touched service is written: its image, then its own update settings',
    );
    assert.equal(state.a.image, 'a:1');
    assert.equal(state.a.up, true);
    // No rollback settings or stash left behind for the next stack deploy
    assert.equal('UpdateConfig' in calls.updates[1].body, false);
    assert.equal(
      'com.molo17.conductor.update-config' in (state.a.labels ?? {}),
      false,
    );
  });

  it('starts a service that is not running what the stack file says', async () => {
    process.env.UPDATE_VERIFY_MAX_WAIT_SECONDS = '0';
    // Untouched since the snapshot, but its tasks are gone after the outage
    const { docker, calls, state } = world({
      a: { image: 'a:1', version: 7, up: true },
      b: { image: 'b:1', version: 7, up: false },
    });
    const { rollback } = load();

    const outcomes = await rollback(
      rollbacks,
      restore(docker, { a: '7@a:1', b: '7@b:1' }),
    );

    assert.ok(outcomes.every(o => o.ok));
    assert.deepEqual(
      calls.updates.map(u => u.id),
      ['gs_b', 'gs_b'],
    );
    assert.equal(state.b.up, true);
    assert.equal(
      'com.molo17.conductor.update-config' in (state.b.labels ?? {}),
      false,
    );
  });

  it('names the services it could not restore when Docker never comes back', async () => {
    process.env.CONDUCTOR_DOCKER_WAIT_MS = '300';
    const { docker, calls } = world(
      {
        a: { image: 'a:2', version: 8, up: false },
        b: { image: 'b:1', version: 7, up: true },
      },
      { pingDown: true },
    );
    const { rollback } = load();

    const outcomes = await rollback(
      rollbacks,
      restore(docker, { a: '7@a:1', b: '7@b:1' }),
    );

    assert.deepEqual(
      outcomes.map(o => [o.id, o.ok]),
      [
        ['a', false],
        ['b', false],
      ],
    );
    assert.match(outcomes[0].error ?? '', /Docker is not reachable/);
    assert.equal(calls.updates.length, 0);
  });

  it('reports a service whose previous image could not be set', async () => {
    process.env.UPDATE_VERIFY_MAX_WAIT_SECONDS = '0';
    const { docker } = world(
      {
        a: { image: 'a:2', version: 8, up: false },
        b: { image: 'b:1', version: 7, up: true },
      },
      { updateFails: new Set(['a']) },
    );
    const { rollback } = load();

    const outcomes = await rollback(
      rollbacks,
      restore(docker, { a: '7@a:1', b: '7@b:1' }),
    );

    assert.equal(outcomes[0].ok, false);
    assert.match(outcomes[0].error ?? '', /cannot update a/);
    assert.equal(outcomes[1].ok, true);
  });
});
