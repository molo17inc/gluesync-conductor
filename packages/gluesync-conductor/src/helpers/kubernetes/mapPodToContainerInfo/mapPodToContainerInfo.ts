import {
  ContainerInfo,
  ContainerState,
  VolumeMount,
} from '../../../models/dockerode.model';
import getCustomLabels from '../../composeFile/getCustomLabels/getCustomLabels';
import { canonicalImageName } from '../../containerRuntime/canonicalImage';
import parseImage from '../../parseImage/parseImage';
import {
  KubernetesContainerStatus,
  KubernetesPod,
  KubernetesVolume,
  KubernetesWorkload,
} from '../kubernetes.model';

type StateAndStatus = Readonly<{
  state: ContainerState | 'unknown';
  status: string;
}>;

// Pod phases onto the container states the UI knows, when the container
// itself has no status yet (not scheduled, image not pulled)
const phaseStates: Readonly<Record<string, ContainerState>> = {
  Pending: 'created',
  Running: 'running',
  Succeeded: 'exited',
  Failed: 'exited',
};

const withReason = (text: string, reason?: string): string =>
  reason ? `${text}: ${reason}` : text;

const toStateAndStatus = (
  pod: Readonly<KubernetesPod>,
  containerStatus?: Readonly<KubernetesContainerStatus>,
): StateAndStatus => {
  if (pod.metadata.deletionTimestamp) {
    return { state: 'removing', status: 'Terminating' };
  }

  const { running, waiting, terminated } = containerStatus?.state ?? {};

  if (running) {
    return {
      state: 'running',
      status: containerStatus?.ready ? 'Running' : 'Running (not ready)',
    };
  }

  if (waiting) {
    return {
      // Kubernetes restarts it by itself, with a growing pause
      state: waiting.reason === 'CrashLoopBackOff' ? 'restarting' : 'created',
      status: withReason('Waiting', waiting.reason),
    };
  }

  if (terminated) {
    return {
      state: 'exited',
      status: `${withReason('Terminated', terminated.reason)} (exit code ${terminated.exitCode ?? 'unknown'})`,
    };
  }

  const phase = pod.status?.phase ?? 'Unknown';

  return {
    state: phaseStates[phase] ?? 'unknown',
    status: withReason(phase, pod.status?.reason),
  };
};

const toUnixSeconds = (iso?: string): number => {
  const millis = Date.parse(iso ?? '');

  return Number.isNaN(millis) ? 0 : Math.floor(millis / 1000);
};

// `containerd://abc` -> `abc`
const withoutRuntime = (containerId?: string): string | undefined =>
  containerId?.replace(/^[a-z0-9.-]+:\/\//i, '') || undefined;

const VOLUME_SOURCES = [
  ['persistentVolumeClaim', 'claimName'],
  ['secret', 'secretName'],
  ['configMap', 'name'],
  ['hostPath', 'path'],
] as const;

// What a volume is and what it is called: (`persistentVolumeClaim`, the claim)
const describeVolume = (
  volume?: Readonly<KubernetesVolume>,
): Readonly<{ type: string; source: string }> => {
  const known = VOLUME_SOURCES.map(([type, key]) => ({
    type,
    source: (volume?.[type] as Readonly<Record<string, string>> | undefined)?.[
      key
    ],
  })).find(({ type }) => volume?.[type] !== undefined);

  if (known) {
    return { type: known.type, source: known.source ?? volume?.name ?? '' };
  }

  const other = Object.keys(volume ?? {}).find(key => key !== 'name');

  return { type: other ?? '', source: volume?.name ?? '' };
};

const toMounts = (
  volumes: ReadonlyArray<KubernetesVolume>,
  mounts: NonNullable<KubernetesWorkload['container']>['volumeMounts'] = [],
): ReadonlyArray<VolumeMount> =>
  mounts.map(mount => ({
    name: mount.name,
    ...describeVolume(volumes.find(({ name }) => name === mount.name)),
    destination: mount.mountPath,
    mode: '',
    rw: !mount.readOnly,
    propagation: '',
  }));

/**
 * The `info` of GET /containers for a workload, from the pod that is shown: in
 * the shape a compose container gets from containerInfoMapper, plus the
 * `kubernetes` details.
 */
const mapPodToContainerInfo = (
  workload: Readonly<KubernetesWorkload>,
  pod: Readonly<KubernetesPod>,
): ContainerInfo => {
  // The pod can still run the previous template during a rollout
  const container =
    pod.spec?.containers?.find(
      ({ name }) => name === workload.container?.name,
    ) ??
    pod.spec?.containers?.[0] ??
    workload.container;
  const containerStatus = pod.status?.containerStatuses?.find(
    ({ name }) => name === container?.name,
  );

  const labels = { ...workload.labels, ...pod.metadata.labels };
  const { service_id: uniqueId, type } = getCustomLabels(labels);
  const image = canonicalImageName(container?.image ?? '') || workload.image;
  const parsedImage = parseImage(image);

  return {
    id:
      withoutRuntime(containerStatus?.containerID) ??
      pod.metadata.uid ??
      pod.metadata.name,
    name: pod.metadata.name,
    image,
    imageID: containerStatus?.imageID ?? '',
    command: '',
    created: toUnixSeconds(pod.metadata.creationTimestamp),
    ports: (container?.ports ?? []).map(port => ({
      ip: pod.status?.podIP ?? '',
      privatePort: port.containerPort,
      // A pod publishes nothing on its node: Services and Ingresses do
      publicPort: 0,
      type: (port.protocol ?? 'TCP').toLowerCase(),
    })),
    labels,
    ...toStateAndStatus(pod, containerStatus),
    hostConfig: { networkMode: 'pod' },
    networkSettings: { networks: {} },
    mounts: toMounts(
      pod.spec?.volumes ?? workload.volumes,
      container?.volumeMounts,
    ),
    tag: parsedImage.tag,
    parsedImage,
    uniqueId,
    type,
    kubernetes: {
      kind: workload.kind,
      name: workload.name,
      namespace: workload.namespace,
      release: workload.release,
      pod: pod.metadata.name,
      node: pod.spec?.nodeName,
      replicas: workload.readyReplicas,
      desiredReplicas: workload.desiredReplicas,
      updatedReplicas: workload.updatedReplicas,
      restarts: containerStatus?.restartCount ?? 0,
    },
  };
};

export default mapPodToContainerInfo;
