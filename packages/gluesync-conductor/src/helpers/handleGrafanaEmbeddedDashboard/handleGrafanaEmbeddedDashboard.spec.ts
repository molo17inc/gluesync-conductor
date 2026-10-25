import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import fakeSwarmDocker, { buildService } from '../../testing/fakeSwarmDocker';
import loadWithStubs from '../../testing/loadWithStubs';
import type { HandleGrafanaEmbeddedDashboard } from './handleGrafanaEmbeddedDashboard.model';

const here = (p: string): string => path.resolve(__dirname, p);

const withVolumes = {
  version: '3',
  services: {
    grafana: {
      image: 'molo17/grafana:13.0.2.dashboard1',
      volumes: ['./grafana:/var/lib/grafana'],
    },
  },
};

const load = (compose: unknown = withVolumes) => {
  const written: unknown[] = [];
  const composeCommands: string[] = [];
  const handle = loadWithStubs<{ default: HandleGrafanaEmbeddedDashboard }>(
    here('./handleGrafanaEmbeddedDashboard'),
    {
      'docker-compose': { rm: 'rm', upAll: 'upAll' },
      [here('../composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => compose,
      },
      [here('../composeFile/writeComposeFile/writeComposeFile')]: {
        default: async (file: unknown) => {
          written.push(file);
        },
      },
      [here('../dockerode/createActions/createActions')]: {
        runCmd: async (command: string, id: string) => {
          composeCommands.push(`${command} ${id}`);
        },
      },
      [here('../../utils/logger')]: {
        getLogger: () => ({ info: () => undefined }),
      },
    },
  ).default;

  return { handle, written, composeCommands };
};

describe('handleGrafanaEmbeddedDashboard', () => {
  it('strips the volumes and recreates the container with docker compose', async () => {
    const { handle, written, composeCommands } = load();

    assert.deepEqual(await handle(), { applied: true, serviceId: 'grafana' });
    assert.deepEqual(written, [
      {
        version: '3',
        services: {
          grafana: { image: 'molo17/grafana:13.0.2.dashboard1' },
        },
      },
    ]);
    assert.deepEqual(composeCommands, ['rm grafana', 'upAll grafana']);
  });

  it('does nothing for an image without the embedded dashboard tag', async () => {
    const { handle, written, composeCommands } = load({
      services: {
        grafana: { image: 'molo17/grafana:13.0.2', volumes: ['a:b'] },
      },
    });

    assert.equal((await handle()).applied, false);
    assert.deepEqual(written, []);
    assert.deepEqual(composeCommands, []);
  });

  it('on Swarm drops the mounts of the service and never runs compose', async () => {
    const { handle, written, composeCommands } = load();
    const grafana = buildService('grafana', {
      image: 'molo17/grafana:13.0.2.dashboard1',
      forceUpdate: 2,
    });
    const { docker, calls } = fakeSwarmDocker({
      services: [
        {
          ...grafana,
          Spec: {
            ...grafana.Spec,
            TaskTemplate: {
              ...grafana.Spec.TaskTemplate,
              ContainerSpec: {
                ...grafana.Spec.TaskTemplate.ContainerSpec,
                Mounts: [{ Type: 'bind', Source: './grafana', Target: '/x' }],
              },
            },
          },
        },
      ],
    });

    assert.deepEqual(await handle({ swarm: { docker, namespace: 'gs' } }), {
      applied: true,
      serviceId: 'grafana',
    });
    assert.equal(written.length, 1, 'the stack file loses the volumes too');
    assert.deepEqual(composeCommands, []);
    const { TaskTemplate } = calls.updates[0].body;
    assert.deepEqual(TaskTemplate.ContainerSpec.Mounts, []);
    assert.equal(TaskTemplate.ForceUpdate, 3);
    assert.equal(
      TaskTemplate.ContainerSpec.Image,
      'molo17/grafana:13.0.2.dashboard1',
    );
  });

  it('on Swarm leaves a service without mounts alone', async () => {
    const { handle, written } = load();
    const { docker, calls } = fakeSwarmDocker({
      services: [
        buildService('grafana', { image: 'molo17/grafana:13.0.2.dashboard1' }),
      ],
    });

    assert.deepEqual(await handle({ swarm: { docker, namespace: 'gs' } }), {
      applied: false,
      serviceId: 'grafana',
    });
    assert.equal(written.length, 1, 'the stack file still loses the volumes');
    assert.equal(calls.updates.length, 0);
  });
});
