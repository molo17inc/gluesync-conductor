import { canonicalImageName } from '../../containerRuntime/canonicalImage';
import {
  KubernetesClient,
  KubernetesLabels,
  KubernetesList,
  KubernetesPod,
  KubernetesWorkload,
  KubernetesWorkloadKind,
  KubernetesWorkloadObject,
} from '../kubernetes.model';
import {
  RELEASE_LABEL,
  toServiceId,
} from '../kubernetesServiceId/kubernetesServiceId';

const selects = (
  selector: KubernetesLabels | undefined,
  labels: KubernetesLabels = {},
): boolean => {
  const wanted = Object.entries(selector ?? {});

  // An empty selector would claim every pod of the namespace
  return (
    wanted.length > 0 && wanted.every(([key, value]) => labels[key] === value)
  );
};

const isRunning = (pod: Readonly<KubernetesPod>): boolean =>
  pod.status?.phase === 'Running' && !pod.metadata.deletionTimestamp;

const createdAt = (pod: Readonly<KubernetesPod>): number =>
  Date.parse(pod.metadata.creationTimestamp ?? '') || 0;

// Running first, then newest first: the first one is the pod shown
const byRunningThenNewest = (
  a: Readonly<KubernetesPod>,
  b: Readonly<KubernetesPod>,
): number =>
  Number(isRunning(b)) - Number(isRunning(a)) || createdAt(b) - createdAt(a);

type Named = Readonly<{
  kind: KubernetesWorkloadKind;
  object: KubernetesWorkloadObject;
  id: string;
}>;

// Two releases in one namespace would give two workloads the same id: the
// first (by kind, then name) keeps it, the others keep their full name
const withUniqueIds = (
  workloads: ReadonlyArray<Omit<Named, 'id'>>,
): ReadonlyArray<Named> =>
  workloads.reduce<ReadonlyArray<Named>>((acc, workload) => {
    const { name, labels } = workload.object.metadata;
    const id = toServiceId(name, labels);

    return [
      ...acc,
      { ...workload, id: acc.some(taken => taken.id === id) ? name : id },
    ];
  }, []);

/**
 * The StatefulSets and Deployments of the Conductor's namespace, each with its
 * Conductor id and the pods its selector matches. Three list calls, whatever
 * the number of workloads.
 */
const listKubernetesWorkloads = async (
  client: KubernetesClient,
): Promise<ReadonlyArray<KubernetesWorkload>> => {
  const { namespace } = client;
  const ns = encodeURIComponent(namespace);

  const [statefulSets, deployments, pods] = await Promise.all([
    client.get<KubernetesList<KubernetesWorkloadObject>>(
      `/apis/apps/v1/namespaces/${ns}/statefulsets`,
    ),
    client.get<KubernetesList<KubernetesWorkloadObject>>(
      `/apis/apps/v1/namespaces/${ns}/deployments`,
    ),
    client.get<KubernetesList<KubernetesPod>>(`/api/v1/namespaces/${ns}/pods`),
  ]);

  const byName = (
    a: Readonly<KubernetesWorkloadObject>,
    b: Readonly<KubernetesWorkloadObject>,
  ): number => a.metadata.name.localeCompare(b.metadata.name);

  const objects = [
    ...[...(statefulSets.items ?? [])]
      .sort(byName)
      .map(object => ({ kind: 'StatefulSet' as const, object })),
    ...[...(deployments.items ?? [])]
      .sort(byName)
      .map(object => ({ kind: 'Deployment' as const, object })),
  ];

  return withUniqueIds(objects).map(({ kind, object, id }) => {
    const labels = object.metadata.labels ?? {};
    const template = object.spec?.template?.spec;
    const container = template?.containers?.[0];

    return {
      kind,
      name: object.metadata.name,
      id,
      namespace,
      release: labels[RELEASE_LABEL] || undefined,
      labels,
      container,
      volumes: template?.volumes ?? [],
      // `docker.io/molo17/x:1` and `molo17/x:1` are the same image
      image: canonicalImageName(container?.image ?? ''),
      desiredReplicas: object.spec?.replicas ?? 1,
      readyReplicas: object.status?.readyReplicas ?? 0,
      updatedReplicas: object.status?.updatedReplicas ?? 0,
      replicas: object.status?.replicas ?? 0,
      observed:
        (object.status?.observedGeneration ?? 0) >=
          (object.metadata.generation ?? 0) &&
        (object.status?.currentRevision ?? '') ===
          (object.status?.updateRevision ?? ''),
      pods: (pods.items ?? [])
        .filter(pod =>
          selects(object.spec?.selector?.matchLabels, pod.metadata.labels),
        )
        .sort(byRunningThenNewest),
    };
  });
};

export default listKubernetesWorkloads;
