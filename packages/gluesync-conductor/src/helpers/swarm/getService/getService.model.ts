import type Docker from 'dockerode';

import { SwarmService } from '../swarm.model';

export type GetService = (
  docker: Readonly<Docker>,
  fullName: string,
) => Promise<SwarmService>;
