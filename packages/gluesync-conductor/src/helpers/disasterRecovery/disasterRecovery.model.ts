import type { EnvFile } from '../../models/composeFile.model';

// The part of a compose service the detection reads. Both the raw and the
// parsed compose file fit: `environment` is a list ("K=V") or a map.
export type DisasterRecoveryService = Readonly<{
  environment?: ReadonlyArray<unknown> | Readonly<Record<string, unknown>>;
  env_file?: EnvFile;
}>;

export type DisasterRecoveryCompose = Readonly<{
  services?: Readonly<Record<string, DisasterRecoveryService | undefined>>;
}>;

export type UpdateBlock = Readonly<{
  updateBlocked: boolean;
  // Why the update is blocked, for a UI to show next to a disabled button
  reason?: string;
}>;

/**
 * Whether the Core Hub of this compose project runs in a disaster-recovery
 * pair: its service has `GS_DR_ENABLED` set to `true` (any case), in
 * `environment` (list or map) or in an `env_file`, `${VAR}` references
 * resolved from the project `.env`. Read from the compose file alone, because
 * a DR standby never answers HTTP.
 */
export type IsDisasterRecoveryEnabled = (
  composeJson: DisasterRecoveryCompose,
) => Promise<boolean>;

/**
 * Whether updating `serviceId` is blocked by disaster recovery. Only Core Hub
 * and Chronos (replicated with it) are; any other service is never blocked.
 */
export type GetDisasterRecoveryUpdateBlock = (
  composeJson: DisasterRecoveryCompose,
  serviceId: string,
) => Promise<UpdateBlock>;

/**
 * The reason an update request must be refused, or `null` when it may go on.
 * An empty id list is "update all", which includes Core Hub and Chronos.
 */
export type GetDisasterRecoveryUpdateRefusal = (
  composeJson: DisasterRecoveryCompose,
  requestIds: ReadonlyArray<string>,
) => Promise<string | null>;
