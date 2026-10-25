import type Docker from 'dockerode';

import { SwarmService } from '../swarm.model';

// Returns the service as it was before the rollback. Rejects when Swarm has no
// previous spec to go back to.
export type RollbackService = (
  docker: Readonly<Docker>,
  fullName: string,
) => Promise<SwarmService>;
