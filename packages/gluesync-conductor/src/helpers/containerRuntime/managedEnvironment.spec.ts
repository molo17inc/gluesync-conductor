import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import { resetOrchestratorCache } from '../orchestrator/getOrchestrator/getOrchestrator';
import { resetContainerEngineCache } from './containerEngine';
import {
  getManagedEnvironment,
  managedEnvironmentHeaders,
  reportManagedEnvironment,
  toManagedEnvironment,
} from './managedEnvironment';

const savedOrchestrator = process.env.CONDUCTOR_ORCHESTRATOR;

const reset = (): void => {
  delete process.env.CONDUCTOR_ORCHESTRATOR;
  resetContainerEngineCache();
  resetOrchestratorCache();
};

beforeEach(reset);
afterEach(() => {
  reset();
  if (savedOrchestrator !== undefined) {
    process.env.CONDUCTOR_ORCHESTRATOR = savedOrchestrator;
  }
});

const DOCKER = {
  engine: 'docker',
  rootless: false,
  version: '29.0.1',
} as const;
const PODMAN = { engine: 'podman', rootless: true, version: '5.8.2' } as const;
const SWARM = {
  mode: 'swarm',
  namespace: 'gs',
  selfService: 'gluesync-conductor',
  isManager: true,
} as const;

describe('toManagedEnvironment', () => {
  it('tells Docker Compose, Docker Swarm and Podman apart', () => {
    assert.equal(
      toManagedEnvironment(DOCKER, { mode: 'compose' }),
      'conductor-docker',
    );
    assert.equal(toManagedEnvironment(DOCKER, SWARM), 'conductor-swarm');
    assert.equal(
      toManagedEnvironment(PODMAN, { mode: 'compose' }),
      'conductor-podman',
    );
  });

  it('knows Podman without the orchestrator (Podman has no Swarm)', () => {
    assert.equal(toManagedEnvironment(PODMAN, undefined), 'conductor-podman');
  });

  it('never guesses when the engine or the orchestrator is unknown', () => {
    assert.equal(
      toManagedEnvironment(undefined, { mode: 'compose' }),
      undefined,
    );
    assert.equal(toManagedEnvironment(DOCKER, undefined), undefined);
  });
});

describe('managedEnvironmentHeaders', () => {
  it('sends Module-Environment only once known', () => {
    assert.deepEqual(managedEnvironmentHeaders('conductor-swarm'), {
      'Module-Environment': 'conductor-swarm',
    });
    assert.deepEqual(managedEnvironmentHeaders(undefined), {});
  });
});

type Setup = Readonly<{
  podman?: boolean;
  labels?: Record<string, string>;
  versionError?: Error;
}>;

const fakeDocker = ({ podman = false, labels = {}, versionError }: Setup) =>
  ({
    version: async () => {
      if (versionError) {
        throw versionError;
      }
      return podman
        ? {
            Version: '5.8.2',
            Components: [{ Name: 'Podman Engine', Version: '5.8.2' }],
          }
        : {
            Version: '29.0.1',
            Components: [{ Name: 'Engine', Version: '29.0.1' }],
          };
    },
    info: async () => ({
      SecurityOptions: [],
      Swarm: { ControlAvailable: true, LocalNodeState: 'active' },
    }),
    getContainer: () => ({
      inspect: async () => ({ Config: { Labels: labels } }),
    }),
  }) as unknown as Docker;

describe('getManagedEnvironment', () => {
  it('answers conductor-docker for a Compose deployment on Docker', async () => {
    assert.equal(
      await getManagedEnvironment(fakeDocker({})),
      'conductor-docker',
    );
  });

  it('answers conductor-swarm for a Conductor deployed as a stack service', async () => {
    assert.equal(
      await getManagedEnvironment(
        fakeDocker({
          labels: {
            'com.docker.swarm.service.name': 'gs_gluesync-conductor',
            'com.docker.stack.namespace': 'gs',
          },
        }),
      ),
      'conductor-swarm',
    );
  });

  it('answers conductor-podman on Podman, even with CONDUCTOR_ORCHESTRATOR=swarm', async () => {
    process.env.CONDUCTOR_ORCHESTRATOR = 'swarm';
    assert.equal(
      await getManagedEnvironment(fakeDocker({ podman: true })),
      'conductor-podman',
    );
  });

  it('answers nothing when the engine cannot be asked', async () => {
    assert.equal(
      await getManagedEnvironment(
        fakeDocker({ versionError: new Error('connect ENOENT') }),
      ),
      undefined,
    );
  });
});

const headerTarget = () => {
  const cell: { provider?: () => Readonly<Record<string, string>> } = {};
  return {
    setExtraHeaders: (provider: () => Readonly<Record<string, string>>) => {
      cell.provider = provider;
    },
    headers: () => cell.provider?.() ?? {},
  };
};

describe('reportManagedEnvironment', () => {
  it('sends Module-Environment once the engine has answered', async () => {
    const target = headerTarget();
    await reportManagedEnvironment(target, () => fakeDocker({ podman: true }));
    assert.deepEqual(target.headers(), {
      'Module-Environment': 'conductor-podman',
    });
  });

  it('does not hold the first connection when the engine never answers', async () => {
    const target = headerTarget();
    const silent = {
      version: () => new Promise(() => {}),
    } as unknown as Docker;
    await reportManagedEnvironment(target, () => silent, 5);
    assert.deepEqual(target.headers(), {});
  });

  it('asks again on the next connection after a failure', async () => {
    const target = headerTarget();
    const engines = [
      fakeDocker({ versionError: new Error('connect ENOENT') }),
      fakeDocker({}),
    ];
    await reportManagedEnvironment(
      target,
      () => engines.shift() ?? fakeDocker({}),
    );
    // First connection: unknown, and a new detection starts in the background
    assert.deepEqual(target.headers(), {});
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    assert.deepEqual(target.headers(), {
      'Module-Environment': 'conductor-docker',
    });
  });

  it('never fails the connection when the client cannot be reached', async () => {
    const target = headerTarget();
    await reportManagedEnvironment(target, () => {
      throw new Error('no socket');
    });
    assert.deepEqual(target.headers(), {});
  });
});
