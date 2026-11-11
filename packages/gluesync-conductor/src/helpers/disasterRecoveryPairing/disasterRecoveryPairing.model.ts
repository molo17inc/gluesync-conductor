export type FailoverMode = 'manual' | 'witness';

/** One site of the pair: the id Core Hub knows it by, and its Core Hub base URL. */
export type DisasterRecoverySite = Readonly<{
  nodeId: string;
  url: string;
}>;

/** What the first site is asked: both sites, and how the standby takes over. */
export type FirstSiteRequest = Readonly<{
  thisSite: DisasterRecoverySite;
  peerSite: DisasterRecoverySite;
  failoverMode: FailoverMode;
  witnessUrl?: string;
  leaseTtlSeconds?: number;
}>;

/** A request that passed validation, urls normalised and the defaults filled in. */
export type ValidFirstSiteRequest = Readonly<{
  thisSite: DisasterRecoverySite;
  peerSite: DisasterRecoverySite;
  failoverMode: FailoverMode;
  witnessUrl: string | null;
  leaseTtlSeconds: number;
}>;

export type ValidationResult<T> =
  | Readonly<{ valid: true; value: T }>
  | Readonly<{ valid: false; problems: ReadonlyArray<string> }>;

export type ValidateFirstSiteRequest = (
  request: unknown,
) => ValidationResult<ValidFirstSiteRequest>;

/**
 * What the pairing code carries: everything the second site needs to join.
 * It contains the shared secret of the pair: whoever reads the code can
 * impersonate a site, so it is only ever shown to the operator who sets the
 * pair up and never logged.
 */
export type PairingPayload = Readonly<{
  v: 1;
  secret: string;
  failoverMode: FailoverMode;
  witnessUrl: string | null;
  leaseTtlSeconds: number;
  first: DisasterRecoverySite;
  joiner: DisasterRecoverySite;
}>;

/** The payload the first site hands out: one place decides which field is which and in what order. */
export type BuildPairingPayload = (
  secret: string,
  request: ValidFirstSiteRequest,
) => PairingPayload;

/** The `GS_DR_*` variables of a first site's env file, by name. */
export type EnvVariables = Readonly<Record<string, string>>;

export type RebuiltPairing =
  | Readonly<{ ok: true; payload: PairingPayload }>
  | Readonly<{
      ok: false;
      /** Variables the code needs that the file does not hold. */
      missing: ReadonlyArray<string>;
      /** Names the problems; never a value. */
      problems: ReadonlyArray<string>;
    }>;

/** The pairing payload of the first site, rebuilt from its env file. */
export type RebuildPairingPayload = (variables: EnvVariables) => RebuiltPairing;

export type EncodePairingCode = (payload: PairingPayload) => string;

/** Throws a `PairingCodeError` when the code is malformed, of another version or not valid. */
export type DecodePairingCode = (code: unknown) => PairingPayload;

export type GenerateSecret = () => string;
