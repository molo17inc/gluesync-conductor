import type Docker from 'dockerode';

import { ConvergeResult } from '../waitForServiceConverged/waitForServiceConverged.model';

// Data plus the clock and the sleep the specs replace
// eslint-disable-next-line functional/no-mixed-types
export type WaitForServiceStoppedOptions = Readonly<{
  // Give up after this long (default 60s)
  maxWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}>;

export type WaitForServiceStopped = (
  docker: Readonly<Docker>,
  fullName: string,
  options?: WaitForServiceStoppedOptions,
) => Promise<ConvergeResult>;
