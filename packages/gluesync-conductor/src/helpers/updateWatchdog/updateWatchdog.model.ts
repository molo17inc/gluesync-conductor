import Docker from 'dockerode';

export type WatchdogResult = Readonly<{ ok: boolean; reason: string }>;

export type HealthStatus = Readonly<{
  running: boolean;
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
}>;

export type RecoveryFunction = (serviceName: string) => Promise<boolean>;

export type ParsedImage = Readonly<{
  registry: string;
  repository: string;
  tag: string;
  fullName: string;
  original: string;
  imageName: string;
  shortImageName: string;
}>;

export type WatchdogOptions = Readonly<{
  serviceName: string;
  helperImageOrName?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  updateModeGraceMs?: number;
  recoveryFunction?: RecoveryFunction;
}>;

export type PollState = Readonly<{
  startMs: number;
  firstNotRunningAt?: number;
  recoveryAttempts: number;
}>;

export type RuntimeValidationResult = Readonly<{
  ok: boolean;
  action: 'ok' | 'poll' | 'recover';
  reason:
    | 'ok'
    | 'version-mismatch'
    | 'missing-image'
    | 'pull-in-progress'
    | 'validation-error';
}>;

/**
 * Main Public Function Type
 */
export type StartUpdateWatchdog = (
  docker: Readonly<Docker>,
  opts: WatchdogOptions,
) => Promise<WatchdogResult>;

/**
 * Internal Recursive Function Type
 */
export type PollWatchdog = (
  docker: Readonly<Docker>,
  opts: WatchdogOptions,
  state: PollState,
) => Promise<WatchdogResult>;

// ------------------------------------------------ pipelines after restart

export type ResumeAfterRestartOutcome =
  | Readonly<{ kind: 'nothing-paused' }>
  // An update started meanwhile: it holds the paused pipelines now
  | Readonly<{ kind: 'left-to-update' }>
  | Readonly<{ kind: 'core-hub-unreachable' }>
  | Readonly<{
      kind: 'resumed';
      resumed: ReadonlyArray<string>;
      notResumed: ReadonlyArray<string>;
    }>;

// eslint-disable-next-line functional/no-mixed-types -- injected steps next to their timing
export type ResumeAfterRestartDeps = Readonly<{
  hasPausedPipelines: () => Promise<boolean>;
  coreHubAnswers: () => Promise<boolean>;
  isUpdateRunning: () => boolean;
  // Resumes under the container-action lock; undefined when another action
  // holds it
  resumeExclusively: () => Promise<
    | Readonly<{
        resumed: ReadonlyArray<string>;
        notResumed: ReadonlyArray<string>;
      }>
    | undefined
  >;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxWaitMs?: number;
  pollMs?: number;
}>;
