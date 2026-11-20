import os from 'node:os';

import { SystemInfo } from '../../../models/dockerode.model';
import { getLogger } from '../../../utils/logger';
import {
  KubernetesClient,
  KubernetesNode,
  KubernetesPod,
} from '../kubernetes.model';
import { getKubernetesClient } from '../kubernetesClient/kubernetesClient';

// How long "the node cannot be read" is remembered before asking again
const RETRY_AFTER_MS = 5 * 60_000;

type NodeCacheEntry = Readonly<{ node?: KubernetesNode; at: number }>;

const nodeCache = new Map<'value', NodeCacheEntry>();

export const resetKubernetesNodeCache = (): void => {
  nodeCache.clear();
};

const BINARY_SUFFIXES: Readonly<Record<string, number>> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
};

const DECIMAL_SUFFIXES: Readonly<Record<string, number>> = {
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
};

/**
 * A Kubernetes quantity as a number: `8`, `7910m` (7.91), `16374572Ki`,
 * `32Gi`, `1e3`. `undefined` for what is not a quantity.
 */
export const parseQuantity = (quantity?: string): number | undefined => {
  const match = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)([A-Za-z]{0,2})$/.exec(
    quantity?.trim() ?? '',
  );

  if (!match) {
    return undefined;
  }

  const [, digits, suffix] = match;
  const factor =
    suffix === '' ? 1 : (BINARY_SUFFIXES[suffix] ?? DECIMAL_SUFFIXES[suffix]);

  return factor === undefined ? undefined : Number(digits) * factor;
};

// eslint-disable-next-line functional/no-mixed-types -- injected dependencies: values and functions together
export type OwnNodeDeps = Readonly<{
  // Name of the Conductor's own pod: POD_NAME, else the hostname
  podName: string;
  now: () => number;
}>;

const defaultDeps = (): OwnNodeDeps => ({
  podName: process.env.POD_NAME?.trim() || os.hostname(),
  now: Date.now,
});

/**
 * The node the Conductor's pod runs on, or `undefined` when it cannot be read.
 * Nodes are cluster-scoped: the namespaced Role of the Conductor does not
 * cover them, so this needs the optional ClusterRole of docs/kubernetes-mode.md.
 * Without it the API answers 403, which is remembered for a while: this is
 * decoration, never a reason to fail a request.
 */
export const readOwnNode = async (
  client: KubernetesClient = getKubernetesClient(),
  overrides: Partial<OwnNodeDeps> = {},
): Promise<KubernetesNode | undefined> => {
  const { podName, now } = { ...defaultDeps(), ...overrides };
  const cached = nodeCache.get('value');

  if (cached && (cached.node || now() - cached.at < RETRY_AFTER_MS)) {
    return cached.node;
  }

  try {
    const pod = await client.get<KubernetesPod>(
      `/api/v1/namespaces/${encodeURIComponent(client.namespace)}/pods/${encodeURIComponent(podName)}`,
    );
    const nodeName = pod.spec?.nodeName;
    const node = nodeName
      ? await client.get<KubernetesNode>(
          `/api/v1/nodes/${encodeURIComponent(nodeName)}`,
        )
      : undefined;

    nodeCache.set('value', { node, at: now() });

    return node;
  } catch (error) {
    getLogger().info(
      { error: error instanceof Error ? error.message : String(error) },
      '[kubernetes] the node of this pod cannot be read: CPU and memory are left out',
    );
    nodeCache.set('value', { at: now() });

    return undefined;
  }
};

/** CPUs and memory of a node, both left out when it could not be read. */
export const nodeSystemInfo = (node?: Readonly<KubernetesNode>): SystemInfo => {
  const cpus = parseQuantity(node?.status?.capacity?.cpu);
  const memory = parseQuantity(node?.status?.capacity?.memory);

  return {
    // Whole CPUs, as Docker reports them
    ncpu: cpus === undefined ? undefined : Math.floor(cpus),
    memTotal: memory === undefined ? undefined : Math.round(memory),
  };
};

/**
 * `systemInfo` of GET /containers: CPUs and memory of the node the Conductor
 * runs on.
 */
const getKubernetesSystemInfo = async (
  client: KubernetesClient = getKubernetesClient(),
  overrides: Partial<OwnNodeDeps> = {},
): Promise<SystemInfo> => nodeSystemInfo(await readOwnNode(client, overrides));

export default getKubernetesSystemInfo;
