import path from 'node:path';

import { KubernetesClient } from '../helpers/kubernetes/kubernetes.model';
import getKubernetesSystemInfo from '../helpers/kubernetes/getKubernetesSystemInfo/getKubernetesSystemInfo';
import listKubernetesContainers, {
  readKubernetesServices,
} from '../helpers/kubernetes/listKubernetesContainers/listKubernetesContainers';
import {
  getKubernetesInfo,
  getKubernetesVersion,
} from '../helpers/kubernetes/kubernetesClusterInfo/kubernetesClusterInfo';

const helpers = path.resolve(__dirname, '../helpers');

// Any use would be a use of the container engine or of the compose file
const mustNotBeUsed = (what: string) => async () => {
  throw new Error(`${what} must not be used on Kubernetes`);
};

/**
 * Stubs for `loadWithStubs` that put a route handler in Kubernetes mode over
 * `client`: the mode is decided, the real Kubernetes helpers read the fake
 * cluster, and the compose file and the Docker daemon throw when touched.
 */
const kubernetesStubs = (
  client: KubernetesClient,
  namespace = client.namespace,
): Readonly<Record<string, unknown>> => ({
  [`${helpers}/orchestrator/getKubernetesOrchestrator/getKubernetesOrchestrator`]:
    { default: () => ({ mode: 'kubernetes', namespace }) },
  // The Docker-backed detection is never asked once the mode is Kubernetes
  [`${helpers}/orchestrator/getOrchestrator/getOrchestrator`]: {
    default: mustNotBeUsed('getOrchestrator'),
  },
  [`${helpers}/kubernetes/listKubernetesContainers/listKubernetesContainers`]: {
    default: () => listKubernetesContainers(client),
    readKubernetesServices: (options?: Readonly<{ raw?: boolean }>) =>
      readKubernetesServices({ ...options, client }),
  },
  [`${helpers}/kubernetes/getKubernetesSystemInfo/getKubernetesSystemInfo`]: {
    default: () =>
      getKubernetesSystemInfo(client, { podName: 'conductor-0', now: () => 0 }),
  },
  [`${helpers}/kubernetes/kubernetesClusterInfo/kubernetesClusterInfo`]: {
    getKubernetesInfo: () =>
      getKubernetesInfo(client, { podName: 'conductor-0', now: () => 0 }),
    getKubernetesVersion: () => getKubernetesVersion(client),
  },
  [`${helpers}/composeFile/readComposeFile/readComposeFile`]: {
    readComposeFile: mustNotBeUsed('the compose file'),
  },
  [`${helpers}/dockerode/waitForDockerDaemon/waitForDockerDaemon`]: {
    default: mustNotBeUsed('the Docker daemon'),
  },
});

/** A Docker client whose every use is recorded: none is expected. */
export const untouchableDocker = () => {
  const uses: string[] = [];
  const docker = new Proxy(
    {},
    {
      get: (_target, property) => {
        // Fastify itself looks for an accessor on a decorator
        if (property !== 'getter' && property !== 'setter') {
          uses.push(String(property));
        }
        return undefined;
      },
    },
  );

  return { docker: docker as never, uses };
};

export default kubernetesStubs;
