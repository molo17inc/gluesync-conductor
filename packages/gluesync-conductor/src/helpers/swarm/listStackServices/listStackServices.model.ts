import type Docker from 'dockerode';

import { SwarmService } from '../swarm.model';

export type ListStackServices = (
  docker: Readonly<Docker>,
  namespace: string,
) => Promise<ReadonlyArray<SwarmService>>;
