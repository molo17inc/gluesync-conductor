import type Docker from 'dockerode';

import { SwarmTask } from '../swarm.model';

export type GetServiceTasksOptions = Readonly<{
  // Also tasks that are being shut down or already failed (default: only the
  // ones that should be running)
  includeStopped?: boolean;
  // Look node hostnames up (default true); one `listNodes` call
  resolveNodes?: boolean;
}>;

// Newest first
export type GetServiceTasks = (
  docker: Readonly<Docker>,
  serviceName: string,
  options?: GetServiceTasksOptions,
) => Promise<ReadonlyArray<SwarmTask>>;
