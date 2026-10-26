import type Docker from 'dockerode';

import { SwarmService } from '../swarm.model';

// Returns the service as it was before
export type ForceUpdateService = (
  docker: Readonly<Docker>,
  fullName: string,
) => Promise<SwarmService>;
