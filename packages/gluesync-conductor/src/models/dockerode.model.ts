import { ParseImageResult } from '../helpers/parseImage/parseImage.model';

export type SystemInfo = Readonly<{
  ncpu?: number;
  memTotal?: number;
}>;

export type Port = Readonly<{
  ip: string;
  privatePort: number;
  publicPort: number;
  type: string;
}>;

export type HostConfig = Readonly<{
  networkMode: string;
}>;

export type NetworkInfo = Readonly<{
  iPAMConfig?: any;
  links?: any;
  aliases?: any;
  networkID: string;
  endpointID: string;
  gateway: string;
  iPAddress: string;
  iPPrefixLen: number;
  iPv6Gateway: string;
  globalIPv6Address: string;
  globalIPv6PrefixLen: number;
  macAddress: string;
}>;

export type NetworkSettings = Readonly<{
  networks: Record<string, NetworkInfo>;
}>;

export type VolumeMount = Readonly<{
  name?: string | undefined;
  type: string;
  source: string;
  destination: string;
  driver?: string | undefined;
  mode: string;
  rw: boolean;
  propagation: string;
}>;

export const containerStateValues = [
  'created',
  'restarting',
  'running',
  'removing',
  'paused',
  'exited',
  'dead',
] as const;

export type ContainerState = (typeof containerStateValues)[number];

// What only Swarm knows about a service (GET /containers in swarm mode)
export type SwarmContainerInfo = Readonly<{
  serviceId: string;
  // Hostname of the node the shown task runs on (node id when unknown)
  node?: string;
  // Tasks running now / wanted
  replicas: number;
  desiredReplicas: number;
  updateState?: string;
}>;

// What only Kubernetes knows about a workload (GET /containers in kubernetes mode)
export type KubernetesContainerInfo = Readonly<{
  kind: 'StatefulSet' | 'Deployment';
  // Name of the workload in the cluster (`<release>-gluesync-core-hub`)
  name: string;
  namespace: string;
  // `app.kubernetes.io/instance` of the workload
  release?: string;
  // The pod shown, and the node it runs on
  pod: string;
  node?: string;
  // Pods ready now / wanted / already on the current template
  replicas: number;
  desiredReplicas: number;
  updatedReplicas: number;
  // Restarts of the container shown
  restarts: number;
}>;

export type ContainerInfo = Readonly<{
  id: string;
  name: string;
  image: string;
  imageID: string;
  type?: string;
  tag: string;
  uniqueId?: string;
  command: string;
  created: number;
  ports: ReadonlyArray<Port>;
  labels: Record<string, string>;
  state: ContainerState | 'unknown';
  status: string;
  hostConfig: HostConfig;
  networkSettings: NetworkSettings;
  mounts: ReadonlyArray<VolumeMount>;
  parsedImage: ParseImageResult;
  swarm?: SwarmContainerInfo;
  kubernetes?: KubernetesContainerInfo;
}>;

// export type ContainerListItem = Readonly<{
//   id: string;
//   name: string;
//   image: string;
//   tag: string;
//   persisted: boolean;
//   created: string;
//   running: boolean;
//   status: string;
//   exitCode: number;
//   startedAt: string;
//   finishedAt: string;
//   cmd: string[];
//   env: string[];
//   labels: Record<string, string>;
//   networkMode: string;
//   privileged: boolean;
//   ports: any[];
//   mounts: any[];
//   hostConfig: any; // Full HostConfig from Docker inspect
// }>;
