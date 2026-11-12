import { CoreHubPipelinesApi } from './coreHubPipelinesApi.model';

// What is kept on disk while an update holds pipelines in maintenance mode
export type PausedPipelinesRecord = Readonly<{
  pausedAt: string;
  pipelineIds: ReadonlyArray<string>;
}>;

export type PausedPipelinesStore = Readonly<{
  read: () => Promise<PausedPipelinesRecord | null>;
  write: (record: PausedPipelinesRecord) => Promise<void>;
  clear: () => Promise<void>;
}>;

export type PauseOutcome = Readonly<{
  // Held in maintenance mode by the update: resumed once Core Hub is back
  paused: ReadonlyArray<string>;
  // In maintenance mode before the update: left there
  alreadyInMaintenance: ReadonlyArray<string>;
  // Set when Core Hub did not answer: nothing was paused, the update goes on
  coreHubUnreachable?: string;
}>;

export type NotResumed = Readonly<{ id: string; error: string }>;

export type ResumeOutcome = Readonly<{
  resumed: ReadonlyArray<string>;
  // Still in maintenance mode: kept on disk, tried again at the next start of
  // the Conductor or by the next update
  notResumed: ReadonlyArray<NotResumed>;
}>;

export type PipelineMaintenance = Readonly<{
  /**
   * Puts every running pipeline in maintenance mode and waits until all of
   * them report it. Throws UpdateRefusedByPipelinesError (after resuming the
   * ones it paused) when that does not happen within the drain timeout.
   */
  pause: () => Promise<PauseOutcome>;
  /** Takes the pipelines on disk out of maintenance mode. Never throws. */
  resume: () => Promise<ResumeOutcome>;
}>;

export type MaintenanceClock = Readonly<{
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}>;

export type PipelineMaintenanceOptions = Readonly<{
  api?: CoreHubPipelinesApi;
  store?: PausedPipelinesStore;
  drainTimeoutMs?: number;
  resumeTimeoutMs?: number;
  // How long a Core Hub that does not answer is waited for before the update
  // goes on without pausing anything
  connectWaitMs?: number;
  pollMs?: number;
  clock?: MaintenanceClock;
}>;
