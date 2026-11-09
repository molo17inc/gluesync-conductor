import type Docker from 'dockerode';

import type { RawComposeFile } from '../../models/composeFile.model';
import type {
  DisasterRecoveryTargets,
  SiteVariables,
} from '../disasterRecoveryCompose/disasterRecoveryCompose.model';

/** What the setup endpoint reports. Never holds a secret. */
export type DisasterRecoveryState = Readonly<{
  supported: boolean;
  reason: string | null;
  enabled: boolean;
  /** True when this setup wrote the variables; DR enabled by hand is enabled but not managed. */
  managedByConductor: boolean;
  nodeId: string | null;
  peerUrl: string | null;
  failoverMode: 'manual' | 'witness' | null;
  witnessUrl: string | null;
  bootstrapActive: boolean;
}>;

export type DisasterRecoveryInspection = Readonly<{
  state: DisasterRecoveryState;
  /** Docker did not answer, so compose could not be told from swarm. */
  dockerUnknown: boolean;
  mode: 'compose' | 'swarm' | undefined;
  targets: DisasterRecoveryTargets;
  compose: Partial<RawComposeFile> | undefined;
}>;

export type InspectDisasterRecovery = (
  docker: Readonly<Docker>,
) => Promise<DisasterRecoveryInspection>;

/** The Core Hub directory Chronos is mounted at is the setup's to choose: it is not part of a request. */
export type DisasterRecoveryChange =
  | Readonly<{ kind: 'enable'; variables: Omit<SiteVariables, 'chronosDir'> }>
  | Readonly<{ kind: 'disable' }>;

/** Files are written and backed up; the containers are not touched yet. */
// eslint-disable-next-line functional/no-mixed-types
export type PreparedDisasterRecoveryChange = Readonly<{
  /** The services `recreate` restarts, Core Hub first. */
  restarting: ReadonlyArray<string>;
  /**
   * Recreates Chronos and Core Hub. When one fails the backed-up files are put
   * back and both are recreated again, then the original error is thrown.
   */
  recreate: () => Promise<void>;
}>;

export type PrepareDisasterRecoveryChange = (
  change: DisasterRecoveryChange,
  targets: DisasterRecoveryTargets,
) => Promise<PreparedDisasterRecoveryChange>;

/** The variables of the DR env file of this site (it holds the secrets of the pair), `undefined` without the file. */
export type ReadDisasterRecoveryEnv = () => Promise<
  Readonly<Record<string, string>> | undefined
>;
