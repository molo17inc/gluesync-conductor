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

export type Orchestrator = ComposeOrchestrator | SwarmOrchestrator;

export type GetOrchestrator = (
  docker: Readonly<Docker>,
) => Promise<Orchestrator>;

// `undefined` when Docker could not be asked: the mode is not decided yet
export type GetDecidedOrchestrator = (
  docker: Readonly<Docker>,
) => Promise<Orchestrator | undefined>;
