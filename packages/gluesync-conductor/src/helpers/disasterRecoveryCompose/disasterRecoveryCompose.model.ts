import type { RawComposeFile } from '../../models/composeFile.model';

/** The compose services DR touches and how the control port is reached. */
export type DisasterRecoveryTargets = Readonly<{
  coreHub: string;
  chronos: string;
  /** Windows containers use Windows paths and the other way of writing an absolute env file path. */
  windows: boolean;
  /** `https` when Core Hub runs with SSL: its control port then serves TLS. */
  controlScheme: 'http' | 'https';
}>;

/** Why the compose file cannot take the DR changes, or `null` when it can. */
export type FindDisasterRecoveryBlocker = (
  compose: Readonly<Partial<RawComposeFile>>,
  targets: DisasterRecoveryTargets,
) => string | null;

export type EditDisasterRecoveryCompose = (
  compose: Readonly<Partial<RawComposeFile>>,
  targets: DisasterRecoveryTargets,
) => Partial<RawComposeFile>;

/** The `GS_DR_*` variables of a site, as written to the DR env file. */
export type SiteVariables = Readonly<{
  nodeId: string;
  peerUrl: string;
  failoverMode: 'manual' | 'witness';
  witnessUrl: string | null;
  leaseTtlSeconds: number;
  sharedSecret: string;
  adminToken: string;
  /** Only the first site keeps its data and starts active. */
  bootstrapActive: boolean;
  chronosDir: string;
}>;

export type RenderDisasterRecoveryEnvFile = (
  variables: SiteVariables,
) => string;
