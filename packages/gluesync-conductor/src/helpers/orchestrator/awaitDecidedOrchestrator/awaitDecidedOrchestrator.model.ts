import type Docker from 'dockerode';

import { Orchestrator } from '../getOrchestrator/getOrchestrator.model';

// Data plus the clock and the sleep the specs replace
// eslint-disable-next-line functional/no-mixed-types
export type AwaitDecidedOrchestratorOptions = Readonly<{
  // Give up after this long (default 60s)
  maxWaitMs?: number;
  // First pause between attempts, doubled each time up to maxDelayMs
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}>;

// `undefined` when Docker still could not be asked after the whole wait
export type AwaitDecidedOrchestrator = (
  docker: Readonly<Docker>,
  options?: AwaitDecidedOrchestratorOptions,
) => Promise<Orchestrator | undefined>;
