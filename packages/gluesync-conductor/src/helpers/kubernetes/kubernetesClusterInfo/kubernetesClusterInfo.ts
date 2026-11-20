import { KubernetesClient, KubernetesVersion } from '../kubernetes.model';
import { getKubernetesClient } from '../kubernetesClient/kubernetesClient';
import {
  OwnNodeDeps,
  nodeSystemInfo,
  readOwnNode,
} from '../getKubernetesSystemInfo/getKubernetesSystemInfo';

// Left out of the answer when unknown, as JSON does with `undefined`
type Optional<T> = { readonly [K in keyof T]?: T[K] };

export type KubernetesVersionReply = Readonly<{ orchestrator: 'kubernetes' }> &
  Optional<{
    Platform: Readonly<{ Name: string }>;
    Version: string;
    GitCommit: string;
    GoVersion: string;
    Os: string;
    Arch: string;
    BuildTime: string;
  }>;

/**
 * `data` of GET /version: the version of the Kubernetes API server under the
 * keys Docker's `version` uses, so a reader of `Version`, `Os` or `Arch`
 * keeps working, plus `orchestrator`.
 */
export const getKubernetesVersion = async (
  client: KubernetesClient = getKubernetesClient(),
): Promise<KubernetesVersionReply> => {
  const version = await client.get<KubernetesVersion>('/version');
  const [os, arch] = (version.platform ?? '').split('/');

  return {
    orchestrator: 'kubernetes',
    Platform: { Name: 'Kubernetes' },
    Version: version.gitVersion,
    GitCommit: version.gitCommit,
    GoVersion: version.goVersion,
    Os: os || undefined,
    Arch: arch || undefined,
    BuildTime: version.buildDate,
  };
};

export type KubernetesInfoReply = Readonly<{
  orchestrator: 'kubernetes';
  namespace: string;
}> &
  Optional<{
    ServerVersion: string;
    Name: string;
    NCPU: number;
    MemTotal: number;
    OSType: string;
    Architecture: string;
    OperatingSystem: string;
    KernelVersion: string;
    ContainerRuntime: string;
  }>;

/**
 * `data` of GET /info: `orchestrator: 'kubernetes'`, the namespace, the
 * version of the API server and, when the node of the pod can be read, what
 * Docker's `info` says about a host under the same keys (`NCPU`, `MemTotal`,
 * `OSType`, `Architecture`, `OperatingSystem`, `KernelVersion`, `Name`).
 */
export const getKubernetesInfo = async (
  client: KubernetesClient = getKubernetesClient(),
  overrides: Partial<OwnNodeDeps> = {},
): Promise<KubernetesInfoReply> => {
  const [version, node] = await Promise.all([
    client.get<KubernetesVersion>('/version'),
    readOwnNode(client, overrides),
  ]);
  const systemInfo = nodeSystemInfo(node);
  const nodeInfo = node?.status?.nodeInfo;

  return {
    orchestrator: 'kubernetes',
    namespace: client.namespace,
    ServerVersion: version.gitVersion,
    Name: node?.metadata.name,
    NCPU: systemInfo.ncpu,
    MemTotal: systemInfo.memTotal,
    OSType: nodeInfo?.operatingSystem,
    Architecture: nodeInfo?.architecture,
    OperatingSystem: nodeInfo?.osImage,
    KernelVersion: nodeInfo?.kernelVersion,
    ContainerRuntime: nodeInfo?.containerRuntimeVersion,
  };
};
