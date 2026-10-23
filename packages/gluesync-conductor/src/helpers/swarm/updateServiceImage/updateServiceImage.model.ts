import type Docker from 'dockerode';

import { SwarmService } from '../swarm.model';

// Returns the service as it was before, so the caller knows the old image
export type UpdateServiceImage = (
  docker: Readonly<Docker>,
  fullName: string,
  image: string,
) => Promise<SwarmService>;
