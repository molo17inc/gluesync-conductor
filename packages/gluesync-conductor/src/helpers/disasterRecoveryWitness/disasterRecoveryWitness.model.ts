import type { AxiosRequestConfig, AxiosResponse } from 'axios';

import type { Refusal } from '../../functions/disasterRecovery/runDisasterRecoveryChange/runDisasterRecoveryChange.model';

/** The node a signed request names, and the secret that signs it (the shared secret of the pair). */
export type WitnessCredentials = Readonly<{ nodeId: string; secret: string }>;

/**
 * What a probe of the witness found.
 * - `answers`: `GET /health` answered as a witness, and, when credentials were given, the witness accepted their signature;
 * - `unreachable`: no answer in time, or an answer that is not a healthy one;
 * - `not-a-witness`: something answered, but not as a witness (`role` is what it said, `null` when it said nothing usable);
 * - `rejected`: the witness is up and refused the signature, so it runs with another secret or its clock is off.
 */
export type WitnessProbe =
  | Readonly<{ kind: 'answers' }>
  | Readonly<{ kind: 'unreachable'; reason: string }>
  | Readonly<{ kind: 'not-a-witness'; role: string | null }>
  | Readonly<{ kind: 'rejected' }>;

export type WitnessProbeDeps = Readonly<{
  request: (config: Readonly<AxiosRequestConfig>) => Promise<AxiosResponse>;
  /** Seconds since the epoch, the timestamp of a signature. */
  nowSeconds: () => number;
  /** 16 random bytes as hex: the nonce of a signature. */
  nonce: () => string;
}>;

/**
 * Probes the witness at `witnessUrl`: `GET /health` is open; with `credentials` it also reads `GET /dr/lease`, the one signed read
 * of a witness, which proves that the witness runs with the same shared secret. Never throws.
 */
export type ProbeWitness = (
  witnessUrl: string,
  credentials?: WitnessCredentials,
  deps?: WitnessProbeDeps,
) => Promise<WitnessProbe>;

/** The warnings the first site answers with, an empty list when the witness answers as it should. */
export type WitnessWarnings = (
  witnessUrl: string,
  probe: WitnessProbe,
) => ReadonlyArray<string>;

/** Why this site cannot join, `null` when the witness is fine. */
export type WitnessJoinRefusal = (
  witnessUrl: string,
  probe: WitnessProbe,
) => Refusal | null;
