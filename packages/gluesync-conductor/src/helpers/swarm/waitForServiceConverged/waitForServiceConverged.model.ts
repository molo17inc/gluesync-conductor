import type Docker from 'dockerode';

// Data plus the clock and the sleep the specs replace
// eslint-disable-next-line functional/no-mixed-types
export type WaitForServiceConvergedOptions = Readonly<{
  // How long the service has to stay converged (UPDATE_VERIFY_SECONDS, 20s)
  windowMs?: number;
  // Give up after this long (UPDATE_VERIFY_MAX_WAIT_SECONDS, 180s)
  maxWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}>;

export type ConvergeResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

export type WaitForServiceConverged = (
  docker: Readonly<Docker>,
  fullName: string,
  options?: WaitForServiceConvergedOptions,
) => Promise<ConvergeResult>;
