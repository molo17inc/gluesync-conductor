import type Docker from 'dockerode';

// Data plus the clock and the sleep the specs replace
// eslint-disable-next-line functional/no-mixed-types
export type WaitForServiceConvergedOptions = Readonly<{
  // How long the service has to stay converged (UPDATE_VERIFY_SECONDS, 20s)
  windowMs?: number;
  // Give up after this long (UPDATE_VERIFY_MAX_WAIT_SECONDS, 180s)
  maxWaitMs?: number;
  // Longest image pull, not counted in maxWaitMs (UPDATE_PULL_MAX_WAIT_SECONDS, 1200s)
  maxPullMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Waits for a Docker API that dropped (default: waitForDockerOutage)
  waitForDocker?: (docker: Readonly<Docker>) => Promise<void>;
}>;

export type ConvergeResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

export type WaitForServiceConverged = (
  docker: Readonly<Docker>,
  fullName: string,
  options?: WaitForServiceConvergedOptions,
) => Promise<ConvergeResult>;
