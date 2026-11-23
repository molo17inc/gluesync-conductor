import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeKubernetesClient, {
  buildPod,
  buildWorkload,
  chartCluster,
} from '../../../testing/fakeKubernetesClient';
import { ImageNotPublishedError } from '../../agentInfo/agentInfo.errors';
import { AgentInfoResponse } from '../../agentInfo/agentInfo.model';
import { PipelineMaintenance } from '../../pipelineMaintenance/pipelineMaintenance.model';
import { RolloutOptions } from '../waitForKubernetesRollout/waitForKubernetesRollout';
import {
  findOperator,
  restartKubernetesWorkloads,
  updateKubernetesWorkloads,
} from './changeKubernetesWorkloads';
import listKubernetesWorkloads from '../listKubernetesWorkloads/listKubernetesWorkloads';

// A clock that never waits: every sleep moves it forward
const fastRollout = (): RolloutOptions => {
  const time = { now: 0 };

  return {
    timeoutMs: 600_000,
    stabilityMs: 20_000,
    clock: {
      now: () => time.now,
      sleep: async ms => {
        // eslint-disable-next-line functional/immutable-data -- the clock of one test
        time.now += ms;
      },
    },
  };
};

const VERSIONS: Readonly<Record<string, string>> = {
  'core-hub': '2.3.2.0',
  chronos: '0.0.80',
  conductor: '1.9.0',
};

const fetchAgentInfo = async (name: string): Promise<AgentInfoResponse> => {
  if (!(name in VERSIONS)) {
    throw new ImageNotPublishedError(name);
  }

  return {
    latestVersionGA: VERSIONS[name],
    latestVersionBeta: `${VERSIONS[name]}-beta`,
  } as AgentInfoResponse;
};

const CORE_HUB_PATH =
  '/apis/apps/v1/namespaces/gluesync/statefulsets/prod-gluesync-core-hub';

describe('updateKubernetesWorkloads', () => {
  it('sets the image of the version on offer, by container name, and reports it once rolled out', async () => {
    const client = fakeKubernetesClient(chartCluster());

    const items = await updateKubernetesWorkloads(['gluesync-core-hub'], 'ga', {
      client,
      rollout: fastRollout(),
      fetchAgentInfo,
    });

    assert.deepEqual(items, [
      { id: 'gluesync-core-hub', status: 'OK', message: 'Updated to 2.3.2.0' },
    ]);
    assert.deepEqual(client.patches, [
      {
        path: CORE_HUB_PATH,
        patch: {
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: 'gluesync-core-hub',
                    image: 'molo17/gluesync-core-hub:2.3.2.0',
                  },
                ],
              },
            },
          },
        },
      },
    ]);
  });

  it('keeps the registry of the image and follows the release channel', async () => {
    const client = fakeKubernetesClient(chartCluster());

    await updateKubernetesWorkloads(['gluesync-chronos'], 'beta', {
      client,
      rollout: fastRollout(),
      fetchAgentInfo,
    });

    assert.match(
      JSON.stringify(client.patches[0].patch),
      /docker\.io\/molo17\/gluesync-chronos:0\.0\.80-beta/,
    );
  });

  it('changes nothing for a service already on the version, an unknown one or an image that is not published', async () => {
    const cluster = chartCluster();
    const upToDate = buildWorkload('prod-gluesync-conductor', {
      image: 'molo17/gluesync-conductor:1.9.0',
      type: 'module',
    });
    const client = fakeKubernetesClient({
      ...cluster,
      deployments: [...cluster.deployments, upToDate],
      pods: [...cluster.pods, buildPod(upToDate, { name: 'other-pod' })],
    });

    const items = await updateKubernetesWorkloads(
      ['gluesync-conductor', 'missing', 'grafana'],
      'ga',
      { client, rollout: fastRollout(), fetchAgentInfo },
    );

    assert.deepEqual(
      items.map(({ id, status }) => [id, status]),
      [
        ['gluesync-conductor', 'OK'],
        ['missing', 'ERROR'],
        ['grafana', 'ERROR'],
      ],
    );
    assert.equal(items[0].message, 'Already on 1.9.0');
    assert.match(items[1].message, /not found in the namespace/);
    assert.match(items[2].message, /not published/);
    assert.deepEqual(client.patches, []);
  });

  it('puts the previous image back when the new one cannot be pulled, and deletes the stuck pod of a StatefulSet', async () => {
    const client = fakeKubernetesClient({
      ...chartCluster(),
      brokenImages: ['molo17/gluesync-core-hub:2.3.2.0'],
    });

    const [item] = await updateKubernetesWorkloads(
      ['gluesync-core-hub'],
      'ga',
      { client, rollout: fastRollout(), fetchAgentInfo },
    );

    assert.equal(item.status, 'ERROR');
    assert.match(item.message, /Update to 2\.3\.2\.0 failed: ImagePullBackOff/);
    assert.match(
      item.message,
      /Rolled back to molo17\/gluesync-core-hub:2\.3\.1\.4\./,
    );
    assert.deepEqual(
      client.patches.map(
        ({ patch }) => JSON.stringify(patch).match(/:[\d.]+"/)?.[0],
      ),
      [':2.3.2.0"', ':2.3.1.4"'],
    );

    const [coreHub] = (await listKubernetesWorkloads(client)).filter(
      ({ id }) => id === 'gluesync-core-hub',
    );

    assert.equal(coreHub.image, 'molo17/gluesync-core-hub:2.3.1.4');
    assert.equal(coreHub.readyReplicas, 1);
  });

  it('updates Core Hub first with its pipelines in maintenance mode, and resumes them when it is stable', async () => {
    const client = fakeKubernetesClient(chartCluster());
    const order: string[] = [];
    const pipelineMaintenance: PipelineMaintenance = {
      pause: async () => {
        order.push(`pause:${client.patches.length}`);
        return { paused: ['p1'], alreadyInMaintenance: [] };
      },
      resume: async () => {
        order.push(`resume:${client.patches.length}`);
        return { resumed: ['p1'], notResumed: [] };
      },
    };

    const items = await updateKubernetesWorkloads(
      ['gluesync-chronos', 'gluesync-core-hub'],
      'ga',
      { client, rollout: fastRollout(), fetchAgentInfo, pipelineMaintenance },
    );

    // Paused before any patch, resumed after Core Hub's alone
    assert.deepEqual(order, ['pause:0', 'resume:1']);
    assert.equal(client.patches[0].path, CORE_HUB_PATH);
    assert.deepEqual(
      items.map(({ id }) => id),
      ['gluesync-chronos', 'gluesync-core-hub'],
    );
    assert.deepEqual(items[1].pausedPipelines, ['p1']);
    assert.deepEqual(items[1].resumedPipelines, ['p1']);
    assert.equal(items[0].pausedPipelines, undefined);
  });

  it('changes its own workload last and does not wait for it', async () => {
    const cluster = chartCluster();
    const conductor = buildWorkload('prod-gluesync-conductor', {
      image: 'molo17/gluesync-conductor:1.8.0',
      type: 'module',
    });
    const client = fakeKubernetesClient({
      ...cluster,
      deployments: [...cluster.deployments, conductor],
      pods: [...cluster.pods, buildPod(conductor, { name: 'conductor-pod' })],
      // Its own new image would never become ready: it is not waited for
      brokenImages: ['molo17/gluesync-conductor:1.9.0'],
    });

    const items = await updateKubernetesWorkloads(
      ['gluesync-conductor', 'gluesync-chronos'],
      'ga',
      {
        client,
        rollout: fastRollout(),
        fetchAgentInfo,
        selfPodName: 'conductor-pod',
      },
    );

    assert.deepEqual(
      client.patches.map(({ path }) => path.split('/').pop()),
      ['prod-gluesync-chronos', 'prod-gluesync-conductor'],
    );
    assert.equal(items[0].status, 'OK');
    assert.match(items[0].message, /Update to 1\.9\.0 started/);
    assert.equal(client.patches.length, 2);
  });
});

describe('restartKubernetesWorkloads', () => {
  it('writes the restart annotation on the pod template of each service', async () => {
    const client = fakeKubernetesClient(chartCluster());

    const items = await restartKubernetesWorkloads(['grafana', 'missing'], {
      client,
      rollout: fastRollout(),
      now: () => new Date('2026-11-23T10:00:00Z'),
    });

    assert.deepEqual(items, [
      { id: 'grafana', status: 'OK', message: 'Restarted' },
      {
        id: 'missing',
        status: 'ERROR',
        message: 'Service missing not found in the namespace',
      },
    ]);
    assert.deepEqual(client.patches, [
      {
        path: '/apis/apps/v1/namespaces/gluesync/deployments/prod-gluesync-grafana',
        patch: {
          spec: {
            template: {
              metadata: {
                annotations: {
                  'kubectl.kubernetes.io/restartedAt':
                    '2026-11-23T10:00:00.000Z',
                },
              },
            },
          },
        },
      },
    ]);
  });

  it('restarts every workload of the namespace when no id is given', async () => {
    const client = fakeKubernetesClient(chartCluster());

    const items = await restartKubernetesWorkloads([], {
      client,
      rollout: fastRollout(),
    });

    assert.equal(items.length, 4);
    assert.ok(items.every(({ status }) => status === 'OK'));
  });
});

describe('findOperator', () => {
  it('finds the Gluesync operator by its Conductor type label', async () => {
    const cluster = chartCluster();
    const operator = buildWorkload('prod-gluesync-operator', {
      image: 'molo17/gluesync-operator:1.0.0',
      type: 'operator',
    });

    assert.equal(
      findOperator(
        await listKubernetesWorkloads(fakeKubernetesClient(cluster)),
      ),
      undefined,
    );
    assert.equal(
      findOperator(
        await listKubernetesWorkloads(
          fakeKubernetesClient({
            ...cluster,
            deployments: [...cluster.deployments, operator],
          }),
        ),
      )?.name,
      'prod-gluesync-operator',
    );
  });
});
