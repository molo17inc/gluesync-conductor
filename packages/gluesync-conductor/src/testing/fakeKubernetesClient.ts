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
  // Images whose pods never start (`ImagePullBackOff`) when a PATCH sets them
  brokenImages?: ReadonlyArray<string>;
}>;

type Patch = Readonly<{
  spec?: Readonly<{
    template?: Readonly<{
      spec?: Readonly<{
        containers?: ReadonlyArray<Readonly<{ name?: string; image?: string }>>;
      }>;
    }>;
  }>;
}>;

// What the cluster does with a new image at once: every pod runs it and is
// ready, or none is when the image cannot be pulled
const rolled = (
  workload: KubernetesWorkloadObject,
  image: string,
  broken: boolean,
): KubernetesWorkloadObject => {
  const replicas = workload.spec?.replicas ?? 1;

  return {
    ...workload,
    spec: {
      ...workload.spec,
      template: {
        ...workload.spec?.template,
        spec: {
          ...workload.spec?.template?.spec,
          containers: (workload.spec?.template?.spec?.containers ?? []).map(
            (container, index) =>
              index === 0 ? { ...container, image } : container,
          ),
        },
      },
    },
    status: {
      replicas,
      readyReplicas: broken ? 0 : replicas,
      updatedReplicas: replicas,
    },
  };
};

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
  brokenImages = [],
}: Cluster = {}): KubernetesClient &
  Readonly<{
    calls: string[];
    // Every PATCH, in order
    patches: Array<Readonly<{ path: string; patch: unknown }>>;
    deleted: string[];
    // The answer of a path from now on (a workload list after a rollout)
    set: (path: string, answer: unknown) => void;
  }> => {
  const calls: string[] = [];
  const patches: Array<Readonly<{ path: string; patch: unknown }>> = [];
  const deleted: string[] = [];
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
    patches,
    deleted,
    set: (path, answer) => {
      answers[path] = answer;
    },
    patch: async <T>(path: string, patch: unknown): Promise<T> => {
      patches.push({ path, patch });

      const image = (patch as Patch).spec?.template?.spec?.containers?.[0]
        ?.image;
      const name = path.split('/').pop() ?? '';
      const listPath = path.slice(0, path.lastIndexOf('/'));
      const podsPath = `/api/v1/namespaces/${namespace}/pods`;
      const list = answers[listPath] as
        | { items: ReadonlyArray<KubernetesWorkloadObject> }
        | undefined;
      const current = list?.items.find(w => w.metadata.name === name);

      if (!image || !list || !current) {
        return (current ?? {}) as T;
      }

      const broken = brokenImages.includes(image);
      const next = rolled(current, image, broken);
      const allPods = (answers[podsPath] as { items: KubernetesPod[] }).items;
      const selector = current.spec?.selector?.matchLabels ?? {};
      const mine = (pod: KubernetesPod): boolean =>
        Object.entries(selector).every(
          ([key, value]) => pod.metadata.labels?.[key] === value,
        );

      answers[listPath] = {
        items: list.items.map(w => (w === current ? next : w)),
      };
      answers[podsPath] = {
        items: allPods.map(pod =>
          mine(pod)
            ? buildPod(next, {
                name: pod.metadata.name,
                ...(broken && {
                  phase: 'Pending',
                  ready: false,
                  state: {
                    waiting: {
                      reason: 'ImagePullBackOff',
                      message: `Back-off pulling image "${image}"`,
                    },
                  },
                }),
              })
            : pod,
        ),
      };

      return next as T;
    },
    delete: async (path: string): Promise<void> => {
      deleted.push(path);
    },
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
