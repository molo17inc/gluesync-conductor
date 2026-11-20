import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeKubernetesClient, {
  buildPod,
  buildWorkload,
  chartCluster,
} from '../../../testing/fakeKubernetesClient';
import listKubernetesWorkloads from './listKubernetesWorkloads';

describe('listKubernetesWorkloads', () => {
  it('lists the StatefulSets and Deployments of the namespace under their Docker ids', async () => {
    const client = fakeKubernetesClient(chartCluster());

    const workloads = await listKubernetesWorkloads(client);

    assert.deepEqual(
      workloads.map(({ kind, name, id, release }) => [kind, name, id, release]),
      [
        ['StatefulSet', 'prod-gluesync-chronos', 'gluesync-chronos', 'prod'],
        ['StatefulSet', 'prod-gluesync-core-hub', 'gluesync-core-hub', 'prod'],
        ['Deployment', 'prod-gluesync-grafana', 'grafana', 'prod'],
        ['Deployment', 'prod-gluesync-prometheus', 'prometheus', 'prod'],
      ],
    );
    assert.deepEqual(client.calls.sort(), [
      '/api/v1/namespaces/gluesync/pods',
      '/apis/apps/v1/namespaces/gluesync/deployments',
      '/apis/apps/v1/namespaces/gluesync/statefulsets',
    ]);
  });

  it('reads the image of the first container, without the Docker Hub host', async () => {
    const [chronos, coreHub] = await listKubernetesWorkloads(
      fakeKubernetesClient(chartCluster()),
    );

    assert.equal(chronos.image, 'molo17/gluesync-chronos:0.0.72');
    assert.equal(coreHub.image, 'molo17/gluesync-core-hub:2.3.1.4');
    assert.equal(coreHub.container?.name, 'gluesync-core-hub');
    assert.equal(coreHub.namespace, 'gluesync');
  });

  it('gives each workload the pods its selector matches, running first then newest', async () => {
    const hub = buildWorkload('prod-gluesync-core-hub', {
      image: 'molo17/gluesync-core-hub:2.3.1.4',
      replicas: 3,
      readyReplicas: 1,
    });
    const other = buildWorkload('prod-gluesync-chronos', {
      image: 'molo17/gluesync-chronos:0.0.72',
    });
    const client = fakeKubernetesClient({
      statefulSets: [hub, other],
      pods: [
        buildPod(hub, {
          name: 'old-pending',
          phase: 'Pending',
          created: '2026-01-01T00:00:00Z',
        }),
        buildPod(hub, {
          name: 'new-pending',
          phase: 'Pending',
          created: '2026-01-03T00:00:00Z',
        }),
        buildPod(hub, { name: 'running', created: '2026-01-02T00:00:00Z' }),
        buildPod(hub, {
          name: 'leaving',
          deleting: true,
          created: '2026-01-04T00:00:00Z',
        }),
        buildPod(other),
      ],
    });

    const workloads = await listKubernetesWorkloads(client);
    const coreHub = workloads.find(({ id }) => id === 'gluesync-core-hub');

    assert.deepEqual(
      coreHub?.pods.map(pod => pod.metadata.name),
      ['running', 'leaving', 'new-pending', 'old-pending'],
    );
    assert.equal(coreHub?.desiredReplicas, 3);
    assert.equal(coreHub?.readyReplicas, 1);
  });

  it('gives a workload with no selector no pod', async () => {
    const hub = buildWorkload('prod-gluesync-core-hub', { image: 'x:1' });
    const bare = { ...hub, spec: { ...hub.spec, selector: {} } };

    const [workload] = await listKubernetesWorkloads(
      fakeKubernetesClient({ statefulSets: [bare], pods: [buildPod(hub)] }),
    );

    assert.deepEqual(workload.pods, []);
  });

  it('keeps the full name for the second workload that would take an id', async () => {
    const workloads = await listKubernetesWorkloads(
      fakeKubernetesClient({
        statefulSets: [
          buildWorkload('a-gluesync-core-hub', { release: 'a', image: 'x:1' }),
          buildWorkload('b-gluesync-core-hub', { release: 'b', image: 'x:2' }),
        ],
      }),
    );

    assert.deepEqual(
      workloads.map(({ id }) => id),
      ['gluesync-core-hub', 'b-gluesync-core-hub'],
    );
  });

  it('answers nothing for an empty namespace and defaults a missing replica count to 1', async () => {
    assert.deepEqual(await listKubernetesWorkloads(fakeKubernetesClient()), []);

    const hub = buildWorkload('solo', { image: 'x:1' });
    const [workload] = await listKubernetesWorkloads(
      fakeKubernetesClient({
        deployments: [
          { metadata: hub.metadata, spec: { template: hub.spec?.template } },
        ],
      }),
    );

    assert.equal(workload.desiredReplicas, 1);
    assert.equal(workload.readyReplicas, 0);
    assert.equal(workload.id, 'solo');
  });

  it('rejects with the API error when a list is forbidden', async () => {
    const client = fakeKubernetesClient({
      paths: {
        '/api/v1/namespaces/gluesync/pods': Object.assign(
          new Error('forbidden'),
          {
            code: 'KUBERNETES_API_ERROR',
            statusCode: 403,
          },
        ),
      },
    });

    await assert.rejects(listKubernetesWorkloads(client), /forbidden/);
  });
});
