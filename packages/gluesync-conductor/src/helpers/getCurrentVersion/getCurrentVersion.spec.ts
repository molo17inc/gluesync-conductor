import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type Docker from 'dockerode';

import fakeSwarmDocker, { buildService } from '../../testing/fakeSwarmDocker';
import loadWithStubs from '../../testing/loadWithStubs';
import { Orchestrator } from '../orchestrator/getOrchestrator/getOrchestrator.model';
import { GetCurrentVersion } from './getCurrentVersion.model';

const SWARM: Orchestrator = {
  mode: 'swarm',
  namespace: 'gs',
  selfService: 'gluesync-conductor',
  isManager: true,
};

const COMPOSE_JSON = {
  services: {
    grafana: { image: 'molo17/grafana:13.0.1' },
    'no-tag': { image: 'molo17/no-tag' },
  },
};

const load = (orchestrator: Orchestrator) =>
  loadWithStubs<{ default: GetCurrentVersion }>(
    path.resolve(__dirname, './getCurrentVersion'),
    {
      [path.resolve(
        __dirname,
        '../orchestrator/getOrchestrator/getOrchestrator',
      )]: { default: async () => orchestrator },
    },
  ).default;

describe('getCurrentVersion in swarm mode', () => {
  const getCurrentVersion = load(SWARM);

  it('takes the tag from the service spec, without the digest', async () => {
    const { docker } = fakeSwarmDocker({
      services: [
        buildService('grafana', {
          image: 'molo17/grafana:13.0.2.dashboard3@sha256:0123456789abcdef',
        }),
      ],
    });

    assert.equal(
      await getCurrentVersion(docker, COMPOSE_JSON, 'grafana', true),
      '13.0.2.dashboard3',
    );
  });

  it('follows the spec while a rolling update has not finished', async () => {
    const { docker } = fakeSwarmDocker({
      services: [
        buildService('grafana', {
          image: 'molo17/grafana:13.0.2',
          state: 'updating',
        }),
      ],
    });

    assert.equal(
      await getCurrentVersion(docker, COMPOSE_JSON, 'grafana', true),
      '13.0.2',
    );
  });

  it('asks for the service of the stack', async () => {
    const { docker } = fakeSwarmDocker({
      // Same name in another stack must not be picked
      services: [buildService('grafana', { image: 'molo17/grafana:9.9.9' })],
    });
    const asked: string[] = [];
    const spy = {
      ...docker,
      getService: (id: string) => {
        asked.push(id);

        return docker.getService(id);
      },
    } as unknown as Docker;

    await getCurrentVersion(spy, COMPOSE_JSON, 'grafana', true);

    assert.deepEqual(asked, ['gs_grafana']);
  });

  it('falls back to the stack file tag when the service is not deployed', async () => {
    const { docker } = fakeSwarmDocker();

    assert.equal(
      await getCurrentVersion(docker, COMPOSE_JSON, 'grafana', true),
      '13.0.1',
    );
  });

  it('falls back to the stack file tag when the spec image has no tag', async () => {
    const { docker } = fakeSwarmDocker({
      services: [buildService('grafana', { image: 'molo17/grafana' })],
    });

    assert.equal(
      await getCurrentVersion(docker, COMPOSE_JSON, 'grafana', true),
      '13.0.1',
    );
  });

  it('is null when neither knows the service', async () => {
    const { docker } = fakeSwarmDocker();

    assert.equal(
      await getCurrentVersion(docker, COMPOSE_JSON, 'ghost', true),
      null,
    );
  });

  it('falls back to the stack file tag when the swarm API fails', async () => {
    const docker = {
      getService: () => ({
        inspect: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
    } as unknown as Docker;

    assert.equal(
      await getCurrentVersion(docker, COMPOSE_JSON, 'grafana', true),
      '13.0.1',
    );
  });

  it('does not ask Docker when it is not ready', async () => {
    const docker = {
      getService: () => {
        throw new Error('must not be called');
      },
    } as unknown as Docker;

    assert.equal(
      await getCurrentVersion(docker, COMPOSE_JSON, 'grafana', false),
      '13.0.1',
    );
  });
});

describe('getCurrentVersion in compose mode', () => {
  const getCurrentVersion = load({ mode: 'compose' });

  it('still reads the image of the running container', async () => {
    const asked: unknown[] = [];
    const docker = {
      listContainers: async (options: unknown) => {
        asked.push(options);

        return [{ Id: 'c1', State: 'running' }];
      },
      getContainer: () => ({
        inspect: async () => ({
          Config: { Image: 'molo17/grafana:13.0.2' },
        }),
      }),
    } as unknown as Docker;

    assert.equal(
      await getCurrentVersion(docker, COMPOSE_JSON, 'grafana', true),
      '13.0.2',
    );
    assert.deepEqual(asked, [
      {
        all: true,
        filters: { label: ['com.docker.compose.service=grafana'] },
      },
    ]);
  });
});
