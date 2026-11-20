import type Docker from 'dockerode';

export type ComposeOrchestrator = Readonly<{ mode: 'compose' }>;

export type SwarmOrchestrator = Readonly<{
  mode: 'swarm';
  // Stack the Conductor belongs to (`com.docker.stack.namespace`)
  namespace: string;
  // Own service name without the `<namespace>_` prefix
  selfService: string;
  // Swarm API calls only work on a manager
  isManager: boolean;
}>;

// No container engine: the workloads of the pod's own namespace are read from
// the Kubernetes API (docs/kubernetes-mode.md)
export type KubernetesOrchestrator = Readonly<{
  mode: 'kubernetes';
  // Namespace the Conductor runs in, the only one it reads
  namespace: string;
}>;

export type Orchestrator =
  | ComposeOrchestrator
  | SwarmOrchestrator
  | KubernetesOrchestrator;

export type GetOrchestrator = (
  docker: Readonly<Docker>,
) => Promise<Orchestrator>;

// `undefined` when Docker could not be asked: the mode is not decided yet
export type GetDecidedOrchestrator = (
  docker: Readonly<Docker>,
) => Promise<Orchestrator | undefined>;
