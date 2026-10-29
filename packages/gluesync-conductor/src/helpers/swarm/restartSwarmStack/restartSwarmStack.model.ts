import type Docker from 'dockerode';

import { SwarmOrchestrator } from '../../orchestrator/getOrchestrator/getOrchestrator.model';

// What happened to each service: the Conductor is `ok` once its restart has
// been requested, nobody is left to watch it
export type RestartSwarmStackResult = ReadonlyArray<
  Readonly<{ id: string; ok: boolean; error?: string }>
>;

export type RestartSwarmStack = (
  docker: Readonly<Docker>,
  orchestrator: SwarmOrchestrator,
) => Promise<RestartSwarmStackResult>;
