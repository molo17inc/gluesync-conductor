import type Docker from 'dockerode';

import { SwarmService } from '../swarm.model';

// Returns the service as it was before. Rejects for a global service.
export type ScaleService = (
  docker: Readonly<Docker>,
  fullName: string,
  replicas: number,
) => Promise<SwarmService>;
