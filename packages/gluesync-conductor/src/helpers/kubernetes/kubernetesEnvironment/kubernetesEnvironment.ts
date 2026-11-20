import fs from 'node:fs';
import os from 'node:os';

import { linuxSocketCandidates } from '../../../utils/docker/getDocker';

// Where the kubelet mounts the service account of a pod
export const SERVICE_ACCOUNT_DIR =
  '/var/run/secrets/kubernetes.io/serviceaccount';

const WINDOWS_ENGINE_PIPE = String.raw`\\.\pipe\docker_engine`;

// eslint-disable-next-line functional/no-mixed-types -- injected dependencies: values and functions together
export type KubernetesEnvironmentDeps = Readonly<{
  env: Readonly<NodeJS.ProcessEnv>;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  platform: NodeJS.Platform;
}>;

const defaultDeps = (): KubernetesEnvironmentDeps => ({
  env: process.env,
  fileExists: path => fs.existsSync(path),
  readFile: path => fs.readFileSync(path, 'utf8'),
  platform: os.platform(),
});

export const serviceAccountFile = (
  name: 'token' | 'ca.crt' | 'namespace',
): string => `${SERVICE_ACCOUNT_DIR}/${name}`;

/** In a pod: the API server address is in the environment and the token is mounted. */
export const isInPod = ({
  env,
  fileExists,
}: Pick<KubernetesEnvironmentDeps, 'env' | 'fileExists'>): boolean =>
  Boolean(env.KUBERNETES_SERVICE_HOST?.trim()) &&
  fileExists(serviceAccountFile('token'));

// The file behind an engine address, when it is one: `unix:///var/run/docker.sock`,
// a bare socket path, or a Windows named pipe (`npipe:////./pipe/docker_engine`).
// `undefined` for a network address, which no file can vouch for.
const addressFile = (address: string): string | undefined => {
  if (address.startsWith('unix://')) {
    return address.slice('unix://'.length);
  }

  if (address.startsWith('npipe://')) {
    return address.slice('npipe://'.length).replaceAll('/', '\\');
  }

  return address.startsWith('/') ? address : undefined;
};

/**
 * A container engine this process could talk to, looked for where `getDocker`
 * would connect: the address in `DOCKER_HOST`, else in `CONTAINER_HOST`, else
 * the well-known sockets. An address that names a socket only counts when the
 * socket is there: the Conductor image sets `DOCKER_HOST` to
 * `/var/run/docker.sock` whether or not the socket is mounted. A pod that
 * mounts the node's engine socket keeps the compose or swarm behaviour it had.
 */
export const hasEngineSocket = ({
  env,
  fileExists,
  platform,
}: Pick<
  KubernetesEnvironmentDeps,
  'env' | 'fileExists' | 'platform'
>): boolean => {
  const address = env.DOCKER_HOST?.trim() || env.CONTAINER_HOST?.trim();

  if (address) {
    const file = addressFile(address);

    return file === undefined || fileExists(file);
  }

  return platform === 'win32'
    ? fileExists(WINDOWS_ENGINE_PIPE)
    : linuxSocketCandidates(env).some(fileExists);
};

/**
 * Namespace the Conductor runs in, which is the only one it reads:
 * `POD_NAMESPACE`, else the service account's `namespace` file, else `default`.
 */
export const readNamespace = ({
  env,
  readFile,
}: Pick<KubernetesEnvironmentDeps, 'env' | 'readFile'>): string => {
  const fromEnv = env.POD_NAMESPACE?.trim();

  if (fromEnv) {
    return fromEnv;
  }

  try {
    return readFile(serviceAccountFile('namespace')).trim() || 'default';
  } catch {
    return 'default';
  }
};

/**
 * Whether this process runs in Kubernetes mode, without asking any daemon:
 * `CONDUCTOR_ORCHESTRATOR=kubernetes` forces it, `compose` or `swarm` rules it
 * out, and otherwise it is a pod with no container engine socket.
 * Returns the namespace, or `undefined` when the mode is not Kubernetes.
 */
export const detectKubernetesNamespace = (
  overrides: Partial<KubernetesEnvironmentDeps> = {},
): string | undefined => {
  const deps = { ...defaultDeps(), ...overrides };
  const forced = deps.env.CONDUCTOR_ORCHESTRATOR?.trim().toLowerCase();

  if (forced === 'kubernetes') {
    return readNamespace(deps);
  }

  if (forced === 'compose' || forced === 'swarm') {
    return undefined;
  }

  return isInPod(deps) && !hasEngineSocket(deps)
    ? readNamespace(deps)
    : undefined;
};
