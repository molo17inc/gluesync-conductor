import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeKubernetesClient, {
  buildPod,
  buildWorkload,
  chartCluster,
} from '../../../testing/fakeKubernetesClient';
import listKubernetesContainers, {
  readKubernetesServices,
} from './listKubernetesContainers';

describe('listKubernetesContainers', () => {
  it('lists the chart workloads as the containers of a Docker kit', async () => {
    const items = await listKubernetesContainers(
      fakeKubernetesClient(chartCluster()),
    );

    assert.deepEqual(
      items.map(({ id, type, persisted, info }) => [
        id,
        type,
        persisted,
        info?.state,
        info?.tag,
      ]),
      [
        ['gluesync-chronos', 'module', true, 'running', '0.0.72'],
        ['gluesync-core-hub', 'core-hub', true, 'running', '2.3.1.4'],
        ['grafana', 'third-party', true, 'running', '13.0.11.dashboard3'],
        ['prometheus', 'third-party', true, 'running', '3.15.1'],
      ],
    );
  });

  it('describes the workload as the compose service: image, labels with the type, literal environment, replicas', async () => {
    const items = await listKubernetesContainers(
      fakeKubernetesClient(chartCluster()),
    );
    const coreHub = items.find(({ id }) => id === 'gluesync-core-hub');
    const grafana = items.find(({ id }) => id === 'grafana');

    assert.deepEqual(coreHub?.service, {
      image: 'molo17/gluesync-core-hub:2.3.1.4',
      labels: {
        'app.kubernetes.io/name': 'gluesync-core-hub',
        'app.kubernetes.io/instance': 'prod',
        'com.molo17.conductor.type': 'core-hub',
      },
      // FROM_SECRET comes from a Secret: its value is not in the manifest
      environment: { SSL_ENABLED: 'true', ADMIN_PASSWORD: 'literal-secret' },
      deploy: { replicas: 1 },
    });
    // The chart labels it `module`: a Docker kit knows it as third-party
    assert.equal(
      grafana?.service?.labels?.['com.molo17.conductor.type'],
      'third-party',
    );
  });

  it('has no info for a workload without pods, like a stopped compose service', async () => {
    const hub = buildWorkload('prod-gluesync-core-hub', {
      image: 'molo17/gluesync-core-hub:2.3.1.4',
      replicas: 0,
    });

    const [item] = await listKubernetesContainers(
      fakeKubernetesClient({ statefulSets: [hub] }),
    );

    assert.equal(item.id, 'gluesync-core-hub');
    assert.equal(item.info, undefined);
    assert.equal(item.service?.deploy?.replicas, 0);
    assert.equal(item.type, 'core-hub');
  });

  it('reports the agent id of an agent and leaves an unknown workload unknown', async () => {
    const agent = buildWorkload('prod-gluesync-mssql-ct', {
      image: 'molo17/gluesync-mssql-ct:2.3.1.4',
      type: 'agent',
      env: [{ name: 'INITIAL_AGENT_ID', value: '7' }],
    });
    const stray = buildWorkload('stray', {
      release: '',
      image: 'busybox:1.36',
    });

    const items = await listKubernetesContainers(
      fakeKubernetesClient({
        deployments: [agent, stray],
        pods: [buildPod(agent)],
      }),
    );

    assert.deepEqual(
      items.map(({ id, type, agentId }) => [id, type, agentId]),
      [
        ['gluesync-mssql-ct', 'agent', '7'],
        ['stray', 'unknown', undefined],
      ],
    );
    assert.equal(
      'com.molo17.conductor.type' in (items[1].service?.labels ?? {}),
      false,
    );
  });
});

describe('readKubernetesServices', () => {
  it('answers the workloads as the services of a compose file, keyed by id', async () => {
    const { services } = await readKubernetesServices({
      client: fakeKubernetesClient(chartCluster()),
    });

    assert.deepEqual(Object.keys(services ?? {}), [
      'gluesync-chronos',
      'gluesync-core-hub',
      'grafana',
      'prometheus',
    ]);
    assert.equal(services?.grafana.image, 'molo17/grafana:13.0.11.dashboard3');
  });

  it('writes labels and environment as key=value lists when raw', async () => {
    const { services } = await readKubernetesServices({
      raw: true,
      client: fakeKubernetesClient(chartCluster()),
    });

    assert.deepEqual(services?.['gluesync-core-hub'], {
      image: 'molo17/gluesync-core-hub:2.3.1.4',
      deploy: { replicas: 1 },
      labels: [
        'app.kubernetes.io/name=gluesync-core-hub',
        'app.kubernetes.io/instance=prod',
        'com.molo17.conductor.type=core-hub',
      ],
      environment: ['SSL_ENABLED=true', 'ADMIN_PASSWORD=literal-secret'],
    });
  });
});
