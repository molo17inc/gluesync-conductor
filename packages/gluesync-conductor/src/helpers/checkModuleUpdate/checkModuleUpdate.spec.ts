/* eslint-disable functional/immutable-data, functional/no-let -- the spec sets the orchestrator environment, which is process state */
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import asSwarmManager from '../../testing/asSwarmManager';
import fakeSwarmDocker, { buildService } from '../../testing/fakeSwarmDocker';
import loadWithStubs from '../../testing/loadWithStubs';
import { resetOrchestratorCache } from '../orchestrator/getOrchestrator/getOrchestrator';
import { CheckModuleUpdate } from './checkModuleUpdate.model';

const asked: string[] = [];
const published = new Map<string, string>();

const checkModuleUpdate = loadWithStubs<{ default: CheckModuleUpdate }>(
  path.resolve(__dirname, './checkModuleUpdate'),
  {
    [path.resolve(__dirname, '../agentInfo/agentInfo')]: {
      default: async (imageName: string) => {
        asked.push(imageName);

        return {
          latestVersionGA: published.get(imageName) ?? '0.2.5',
          latestVersionBeta: '0.3.0-beta',
        };
      },
    },
    [path.resolve(
      __dirname,
      '../dockerode/waitForDockerDaemon/waitForDockerDaemon',
    )]: { default: async () => undefined },
  },
).default;

const COMPOSE_JSON = {
  services: {
    'gluesync-chronos': { image: 'molo17/gluesync-chronos:0.2.4' },
  },
};

const saved = {
  mode: process.env.CONDUCTOR_ORCHESTRATOR,
  namespace: process.env.SWARM_STACK_NAMESPACE,
};

beforeEach(() => {
  process.env.CONDUCTOR_ORCHESTRATOR = 'swarm';
  process.env.SWARM_STACK_NAMESPACE = 'gs';
  resetOrchestratorCache();
  asked.length = 0;
  published.clear();
});

afterEach(() => {
  [
    ['CONDUCTOR_ORCHESTRATOR', saved.mode],
    ['SWARM_STACK_NAMESPACE', saved.namespace],
  ].forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key as string];
    } else {
      process.env[key as string] = value;
    }
  });
  resetOrchestratorCache();
});

describe('checkModuleUpdate in swarm mode', () => {
  it('compares the tag of the service spec with the published one', async () => {
    const { docker } = fakeSwarmDocker({
      services: [
        // The stack file still says 0.2.4: the spec is what runs
        buildService('gluesync-chronos', {
          image: 'molo17/gluesync-chronos:0.2.5@sha256:abc',
        }),
      ],
    });

    const result = await checkModuleUpdate(
      asSwarmManager(docker),
      COMPOSE_JSON,
      'ga',
      'gluesync-chronos',
    );

    assert.deepEqual(result, {
      needsUpdate: false,
      id: 'gluesync-chronos',
      availableVersion: '0.2.5',
    });
    assert.deepEqual(asked, ['chronos']);
  });

  it('needs an update when the spec is behind', async () => {
    const { docker } = fakeSwarmDocker({
      services: [
        buildService('gluesync-chronos', {
          image: 'molo17/gluesync-chronos:0.2.4@sha256:abc',
        }),
      ],
    });

    const result = await checkModuleUpdate(
      asSwarmManager(docker),
      COMPOSE_JSON,
      'ga',
      'gluesync-chronos',
    );

    assert.equal(result?.needsUpdate, true);
  });

  it('falls back to the stack file tag for a service not deployed yet', async () => {
    const { docker } = fakeSwarmDocker();

    const result = await checkModuleUpdate(
      asSwarmManager(docker),
      COMPOSE_JSON,
      'ga',
      'gluesync-chronos',
    );

    assert.equal(result?.needsUpdate, true);
    assert.equal(result?.availableVersion, '0.2.5');
  });
});

describe('checkModuleUpdate for the Conductor itself', () => {
  const stack = {
    services: {
      'gluesync-conductor': { image: 'gluesync-conductor:swarm-dev' },
    },
  };

  const check = (running: string, latest: string) => {
    published.set('conductor', latest);
    const { docker } = fakeSwarmDocker({
      services: [
        buildService('gluesync-conductor', {
          image: `gluesync-conductor:${running}`,
        }),
      ],
    });

    return checkModuleUpdate(
      asSwarmManager(docker),
      stack,
      'ga',
      'gluesync-conductor',
    );
  };

  it('refuses a GA older than the running release in swarm mode', async () => {
    const result = await check('0.14.0', '0.13.2');

    assert.equal(result?.needsUpdate, false);
    assert.equal(result?.availableVersion, '0.13.2');
    assert.match(
      result?.refusal ?? '',
      /0\.13\.2 is not newer than the running 0\.14\.0/,
    );
  });

  it('refuses any GA while the running version is a dev build', async () => {
    const result = await check('swarm-dev', '0.13.2');

    assert.equal(result?.needsUpdate, false);
    assert.match(result?.refusal ?? '', /"swarm-dev" is not a release version/);
  });

  it('lets a newer release through', async () => {
    const result = await check('0.13.2', '0.14.0');

    assert.equal(result?.needsUpdate, true);
    assert.equal(result?.refusal, undefined);
  });

  it('has nothing to refuse when it already runs the GA', async () => {
    const result = await check('0.14.0', '0.14.0');

    assert.deepEqual(result, {
      needsUpdate: false,
      id: 'gluesync-conductor',
      availableVersion: '0.14.0',
    });
  });

  it('does not guard another service in swarm mode', async () => {
    const { docker } = fakeSwarmDocker({
      services: [
        buildService('gluesync-chronos', {
          image: 'molo17/gluesync-chronos:9.9.9',
        }),
      ],
    });

    const result = await checkModuleUpdate(
      asSwarmManager(docker),
      COMPOSE_JSON,
      'ga',
      'gluesync-chronos',
    );

    assert.equal(result?.needsUpdate, true);
    assert.equal(result?.refusal, undefined);
  });

  it('never guards in compose mode', async () => {
    process.env.CONDUCTOR_ORCHESTRATOR = 'compose';
    resetOrchestratorCache();
    published.set('conductor', '0.13.2');
    // No container yet: the stack file tag is the running one
    const docker = { listContainers: async () => [] };

    const result = await checkModuleUpdate(
      docker as never,
      stack,
      'ga',
      'gluesync-conductor',
    );

    assert.equal(result?.needsUpdate, true);
    assert.equal(result?.refusal, undefined);
  });
});
