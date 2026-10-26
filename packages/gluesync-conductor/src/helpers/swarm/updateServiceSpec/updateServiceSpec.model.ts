import type Docker from 'dockerode';

import { SwarmService } from '../swarm.model';

export type UpdateServiceSpecOptions = Readonly<{
  // Extra query parameters of the update call (e.g. `rollback: 'previous'`)
  query?: Readonly<Record<string, string | number | boolean>>;
}>;

// Returns the service as it was before the update
export type UpdateServiceSpec = (
  docker: Readonly<Docker>,
  fullName: string,
  change: (
    spec: Readonly<Docker.ServiceSpec>,
    current: Readonly<SwarmService>,
  ) => Docker.ServiceSpec,
  options?: UpdateServiceSpecOptions,
) => Promise<SwarmService>;
