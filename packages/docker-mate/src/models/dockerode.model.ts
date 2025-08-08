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

export type ContainerInfo = Readonly<{
  id: string;
  name: string;
  image: string;
  imageID: string;
  type?: string;
  tag: string;
  versionTag?: string;
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
}>;

// export type ContainerListItem = Readonly<{
//   id: string;
//   name: string;
//   image: string;
//   tag: string;
//   versionTag: string;
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
