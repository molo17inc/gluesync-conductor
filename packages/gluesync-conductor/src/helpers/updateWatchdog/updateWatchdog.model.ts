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
