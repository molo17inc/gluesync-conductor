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
  /**
   * `GS_DR_SETUP_ID`: a UUID v4 made anew by every run of a guided setup, never part of the pairing code (each site has its own).
   * Core Hub tells a deliberate new pairing from a changed or mistyped shared secret by it.
   */
  setupId: string;
  adminToken: string;
  /** Only the first site keeps its data and starts active. */
  bootstrapActive: boolean;
  /** Only the first site: what its pairing code needs besides the variables above. */
  pairing?: Readonly<{ thisSiteUrl: string; peerNodeId: string }>;
  chronosDir: string;
}>;

export type RenderDisasterRecoveryEnvFile = (
  variables: SiteVariables,
) => string;
