import { detectKubernetesNamespace } from '../../kubernetes/kubernetesEnvironment/kubernetesEnvironment';
import { KubernetesOrchestrator } from '../getOrchestrator/getOrchestrator.model';

// Decided from the environment alone, so it is known (or ruled out) before
// anything asks a container engine, and it cannot change while the process
// runs. `null`: not Kubernetes.
const cache = new Map<'value', KubernetesOrchestrator | null>();

export const resetKubernetesOrchestratorCache = (): void => {
  cache.clear();
};

/**
 * The Kubernetes mode when this process runs in it, `undefined` in compose and
 * swarm. Synchronous and never touches Docker: callers use it to leave the
 * container engine and the compose file alone (see docs/kubernetes-mode.md).
 * `getOrchestrator` answers the same mode to the callers that have a Docker
 * client at hand.
 */
const getKubernetesOrchestrator = (): KubernetesOrchestrator | undefined => {
  if (!cache.has('value')) {
    const namespace = detectKubernetesNamespace();

    cache.set(
      'value',
      namespace === undefined ? null : { mode: 'kubernetes', namespace },
    );
  }

  return cache.get('value') ?? undefined;
};

export default getKubernetesOrchestrator;
