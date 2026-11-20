import {
  KubernetesClient,
  KubernetesPod,
  KubernetesWorkloadObject,
} from '../helpers/kubernetes/kubernetes.model';
import { KUBERNETES_API_ERROR } from '../helpers/kubernetes/kubernetesClient/kubernetesClient';

type WorkloadOptions = Readonly<{
  release?: string;
  image: string;
  container?: string;
  type?: string;
  replicas?: number;
  readyReplicas?: number;
  env?: ReadonlyArray<Readonly<Record<string, unknown>>>;
}>;

/** A StatefulSet or Deployment the way the Gluesync chart writes one. */
export const buildWorkload = (
  name: string,
  {
    release = 'prod',
    image,
    container = name,
    type,
    replicas = 1,
    readyReplicas = replicas,
    env,
  }: WorkloadOptions,
): KubernetesWorkloadObject => {
  const selector = {
    'app.kubernetes.io/name': name.replace(`${release}-`, ''),
    'app.kubernetes.io/instance': release,
  };

  return {
    metadata: {
      name,
      namespace: 'gluesync',
      labels: {
        ...selector,
        ...(type ? { 'com.molo17.conductor.type': type } : {}),
      },
    },
    spec: {
      replicas,
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: selector },
        spec: {
          containers: [
            {
              name: container,
              image,
              env: env as never,
              ports: [{ containerPort: 1717, protocol: 'TCP' }],
              volumeMounts: [
                { name: 'data', mountPath: '/opt/gluesync/data' },
                { name: 'shared', mountPath: '/shared', readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: 'data', persistentVolumeClaim: { claimName: 'data-pvc' } },
            { name: 'shared', secret: { secretName: 'prod-gluesync-shared' } },
          ],
        },
      },
    },
    status: { replicas, readyReplicas, updatedReplicas: replicas },
  } as KubernetesWorkloadObject;
};

type PodOptions = Readonly<{
  name?: string;
  phase?: string;
  state?: Readonly<Record<string, unknown>>;
  ready?: boolean;
  created?: string;
  node?: string;
  deleting?: boolean;
  restarts?: number;
}>;

/** A pod of `workload`, running unless told otherwise. */
export const buildPod = (
  workload: KubernetesWorkloadObject,
  {
    name = `${workload.metadata.name}-0`,
    phase = 'Running',
    state = { running: { startedAt: '2026-01-01T00:00:10Z' } },
    ready = true,
    created = '2026-01-01T00:00:00Z',
    node = 'node-a',
    deleting = false,
    restarts = 0,
  }: PodOptions = {},
): KubernetesPod => {
  const template = workload.spec?.template;
  const container = template?.spec?.containers?.[0];

  return {
    metadata: {
      name,
      namespace: 'gluesync',
      uid: `uid-${name}`,
      labels: template?.metadata?.labels,
      creationTimestamp: created,
      ...(deleting ? { deletionTimestamp: '2026-01-02T00:00:00Z' } : {}),
    },
    spec: { ...template?.spec, nodeName: node },
    status: {
      phase,
      podIP: '10.0.0.7',
      containerStatuses: [
        {
          name: container?.name ?? '',
          ready,
          restartCount: restarts,
          image: container?.image,
          imageID: `docker-pullable://${container?.image}@sha256:abc`,
          containerID: `containerd://cid-${name}`,
          state,
        },
      ],
    },
  } as KubernetesPod;
};

export const apiError = (statusCode: number, path: string): Error =>
  Object.assign(
    new Error(`Kubernetes API answered ${statusCode} to GET ${path}`),
    {
      code: KUBERNETES_API_ERROR,
      statusCode,
      path,
    },
  );

type Cluster = Readonly<{
  namespace?: string;
  statefulSets?: ReadonlyArray<KubernetesWorkloadObject>;
  deployments?: ReadonlyArray<KubernetesWorkloadObject>;
  pods?: ReadonlyArray<KubernetesPod>;
  // Any other path: its answer, or the error to reject with
  paths?: Readonly<Record<string, unknown>>;
}>;

/**
 * A Kubernetes client that answers from memory and records the paths it was
 * asked. A path it does not know is answered 404, like the API server.
 */
const fakeKubernetesClient = ({
  namespace = 'gluesync',
  statefulSets = [],
  deployments = [],
  pods = [],
  paths = {},
}: Cluster = {}): KubernetesClient & Readonly<{ calls: string[] }> => {
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    [`/apis/apps/v1/namespaces/${namespace}/statefulsets`]: {
      items: statefulSets,
    },
    [`/apis/apps/v1/namespaces/${namespace}/deployments`]: {
      items: deployments,
    },
    [`/api/v1/namespaces/${namespace}/pods`]: { items: pods },
    ...paths,
  };

  return {
    namespace,
    calls,
    get: async <T>(path: string): Promise<T> => {
      calls.push(path);

      const answer = path in answers ? answers[path] : apiError(404, path);

      if (answer instanceof Error) {
        throw answer;
      }

      return answer as T;
    },
  };
};

/** The four workloads of the Gluesync chart for release `prod`, all running. */
export const chartCluster = (): Required<
  Pick<Cluster, 'statefulSets' | 'deployments' | 'pods'>
> => {
  const coreHub = buildWorkload('prod-gluesync-core-hub', {
    image: 'molo17/gluesync-core-hub:2.3.1.4',
    container: 'gluesync-core-hub',
    type: 'core-hub',
    env: [
      { name: 'SSL_ENABLED', value: 'true' },
      { name: 'ADMIN_PASSWORD', value: 'literal-secret' },
      { name: 'FROM_SECRET', valueFrom: { secretKeyRef: { name: 's' } } },
    ],
  });
  const chronos = buildWorkload('prod-gluesync-chronos', {
    image: 'docker.io/molo17/gluesync-chronos:0.0.72',
    container: 'gluesync-chronos',
    type: 'module',
  });
  const grafana = buildWorkload('prod-gluesync-grafana', {
    image: 'molo17/grafana:13.0.11.dashboard3',
    container: 'grafana',
    type: 'module',
  });
  const prometheus = buildWorkload('prod-gluesync-prometheus', {
    image: 'molo17/prometheus:3.15.1',
    container: 'prometheus',
    type: 'module',
  });

  return {
    statefulSets: [coreHub, chronos],
    deployments: [grafana, prometheus],
    pods: [
      buildPod(coreHub),
      buildPod(chronos),
      buildPod(grafana, { name: 'prod-gluesync-grafana-6d5f-abcde' }),
      buildPod(prometheus, { name: 'prod-gluesync-prometheus-7c9b-fghij' }),
    ],
  };
};

export default fakeKubernetesClient;
