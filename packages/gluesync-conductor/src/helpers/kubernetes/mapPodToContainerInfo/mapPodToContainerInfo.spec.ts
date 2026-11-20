import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeKubernetesClient, {
  buildPod,
  buildWorkload,
} from '../../../testing/fakeKubernetesClient';
import { KubernetesPod } from '../kubernetes.model';
import listKubernetesWorkloads from '../listKubernetesWorkloads/listKubernetesWorkloads';
import mapPodToContainerInfo from './mapPodToContainerInfo';

const hub = buildWorkload('prod-gluesync-core-hub', {
  image: 'docker.io/molo17/gluesync-core-hub:2.3.1.4',
  container: 'gluesync-core-hub',
  type: 'core-hub',
  replicas: 2,
  readyReplicas: 1,
});

const infoOf = async (pod: KubernetesPod) => {
  const [workload] = await listKubernetesWorkloads(
    fakeKubernetesClient({ statefulSets: [hub], pods: [pod] }),
  );

  return mapPodToContainerInfo(workload, workload.pods[0] ?? pod);
};

describe('mapPodToContainerInfo', () => {
  it('maps a running pod onto the info of a compose container', async () => {
    const info = await infoOf(buildPod(hub, { restarts: 2 }));

    assert.equal(info.id, 'cid-prod-gluesync-core-hub-0');
    assert.equal(info.name, 'prod-gluesync-core-hub-0');
    assert.equal(info.image, 'molo17/gluesync-core-hub:2.3.1.4');
    assert.equal(info.tag, '2.3.1.4');
    assert.equal(info.parsedImage.imageName, 'gluesync-core-hub');
    assert.equal(info.state, 'running');
    assert.equal(info.status, 'Running');
    assert.equal(info.type, 'core-hub');
    assert.equal(info.created, Date.parse('2026-01-01T00:00:00Z') / 1000);
    assert.deepEqual(info.ports, [
      { ip: '10.0.0.7', privatePort: 1717, publicPort: 0, type: 'tcp' },
    ]);
    assert.deepEqual(info.hostConfig, { networkMode: 'pod' });
    assert.deepEqual(info.networkSettings, { networks: {} });
    assert.deepEqual(info.mounts, [
      {
        name: 'data',
        type: 'persistentVolumeClaim',
        source: 'data-pvc',
        destination: '/opt/gluesync/data',
        mode: '',
        rw: true,
        propagation: '',
      },
      {
        name: 'shared',
        type: 'secret',
        source: 'prod-gluesync-shared',
        destination: '/shared',
        mode: '',
        rw: false,
        propagation: '',
      },
    ]);
    assert.deepEqual(info.kubernetes, {
      kind: 'StatefulSet',
      name: 'prod-gluesync-core-hub',
      namespace: 'gluesync',
      release: 'prod',
      pod: 'prod-gluesync-core-hub-0',
      node: 'node-a',
      replicas: 1,
      desiredReplicas: 2,
      updatedReplicas: 2,
      restarts: 2,
    });
  });

  it('maps the state of the container onto the states the UI knows', async () => {
    const cases: ReadonlyArray<
      readonly [Parameters<typeof buildPod>[1], string, string]
    > = [
      [{ ready: false }, 'running', 'Running (not ready)'],
      [
        {
          phase: 'Pending',
          state: { waiting: { reason: 'ContainerCreating' } },
        },
        'created',
        'Waiting: ContainerCreating',
      ],
      [
        { state: { waiting: { reason: 'CrashLoopBackOff' } } },
        'restarting',
        'Waiting: CrashLoopBackOff',
      ],
      [
        {
          phase: 'Pending',
          state: { waiting: { reason: 'ImagePullBackOff' } },
        },
        'created',
        'Waiting: ImagePullBackOff',
      ],
      [
        {
          phase: 'Failed',
          state: { terminated: { reason: 'Error', exitCode: 137 } },
        },
        'exited',
        'Terminated: Error (exit code 137)',
      ],
      [{ deleting: true }, 'removing', 'Terminating'],
    ];

    const results = await Promise.all(
      cases.map(async ([options]) => {
        const { state, status } = await infoOf(buildPod(hub, options));
        return [state, status];
      }),
    );

    assert.deepEqual(
      results,
      cases.map(([, state, status]) => [state, status]),
    );
  });

  it('uses the pod phase while the container has no status yet', async () => {
    const pending = buildPod(hub, { phase: 'Pending' });
    const unscheduled = {
      ...pending,
      status: { phase: 'Pending', reason: 'Unschedulable' },
    };
    const lost = { ...pending, status: { phase: 'Unknown' } };

    const first = await infoOf(unscheduled);
    const second = await infoOf(lost);

    assert.deepEqual(
      [first.state, first.status],
      ['created', 'Pending: Unschedulable'],
    );
    assert.deepEqual([second.state, second.status], ['unknown', 'Unknown']);
    // No container id yet: the pod uid stands in
    assert.equal(first.id, 'uid-prod-gluesync-core-hub-0');
    assert.equal(first.imageID, '');
    assert.equal(first.kubernetes?.restarts, 0);
  });

  it('shows the image the pod runs, which lags the workload during a rollout', async () => {
    const pod = buildPod(hub);
    const previous = {
      ...pod,
      spec: {
        ...pod.spec,
        containers: [
          {
            ...pod.spec?.containers?.[0],
            image: 'molo17/gluesync-core-hub:2.3.1.3',
          },
        ],
      },
    } as KubernetesPod;

    assert.equal((await infoOf(previous)).tag, '2.3.1.3');
  });
});
