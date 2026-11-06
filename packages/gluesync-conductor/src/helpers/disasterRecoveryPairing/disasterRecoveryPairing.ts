import { randomBytes } from 'node:crypto';

import { PairingCodeError } from './disasterRecoveryPairing.errors';
import {
  DecodePairingCode,
  DisasterRecoverySite,
  EncodePairingCode,
  FailoverMode,
  GenerateSecret,
  PairingPayload,
  ValidateFirstSiteRequest,
  ValidationResult,
} from './disasterRecoveryPairing.model';

export const PAIRING_CODE_PREFIX = 'GSDR1.';

export const DEFAULT_LEASE_TTL_SECONDS = 30;
// With a witness the active node halts 10 s before the lease expires (DrSettings.kt)
export const MIN_LEASE_TTL_SECONDS = 20;
export const MAX_LEASE_TTL_SECONDS = 600;

// Core Hub needs at least 32 characters: 32 random bytes are 43 in base64url
const SECRET_BYTES = 32;

// DrSettings.kt NODE_ID_REGEX
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FAILOVER_MODES: ReadonlyArray<string> = ['manual', 'witness'];
const BASE64URL = /^[A-Za-z0-9_-]+$/;

// scheme://host[:port], no path, query, fragment or user info (DrSettings.kt checkBaseUrl)
const SITE_URL =
  /^(https?):\/\/((?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)|\[[0-9A-Fa-f:.]+\]):(\d{1,5})\/?$/i;
// The witness URL may have a path; it ends in an env file, so only characters that need no quoting
const WITNESS_URL =
  /^(https?):\/\/((?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?(\/[A-Za-z0-9._~/%+=&?,:@-]*)?$/i;
// A secret ends in an env file too: base64url, as generateSecret makes it
const SECRET = /^[A-Za-z0-9_-]{32,}$/;
const MAX_PORT = 65_535;

export const generateSecret: GenerateSecret = () =>
  randomBytes(SECRET_BYTES).toString('base64url');

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const portInRange = (port: string): boolean =>
  Number(port) >= 1 && Number(port) <= MAX_PORT;

// The URL as Core Hub wants it: lower-case scheme and host, no trailing slash
const normalizeSiteUrl = (raw: string): string | null => {
  const match = SITE_URL.exec(raw.trim());

  return match && portInRange(match[3])
    ? `${match[1].toLowerCase()}://${match[2].toLowerCase()}:${Number(match[3])}`
    : null;
};

const normalizeWitnessUrl = (raw: string): string | null => {
  const match = WITNESS_URL.exec(raw.trim());

  return match && (match[3] === undefined || portInRange(match[3]))
    ? raw.trim()
    : null;
};

const validateSite = (
  label: string,
  site: unknown,
): ValidationResult<DisasterRecoverySite> => {
  if (!isRecord(site)) {
    return { valid: false, problems: [`${label} is required`] };
  }

  const { nodeId, url } = site;
  const problems = [
    typeof nodeId === 'string' && NODE_ID.test(nodeId)
      ? undefined
      : `${label}.nodeId must be 1 to 32 characters, lower-case letters, digits and "-", starting with a letter or digit`,
    typeof url === 'string' && normalizeSiteUrl(url) !== null
      ? undefined
      : `${label}.url must be http:// or https:// host:port, with no path (for example http://10.0.0.2:1717)`,
  ].filter((problem): problem is string => problem !== undefined);

  return problems.length > 0
    ? { valid: false, problems }
    : {
        valid: true,
        value: {
          nodeId: nodeId as string,
          url: normalizeSiteUrl(url as string) as string,
        },
      };
};

const validateFailover = (
  failoverMode: unknown,
  witnessUrl: unknown,
  leaseTtlSeconds: unknown,
): ValidationResult<
  Readonly<{
    failoverMode: FailoverMode;
    witnessUrl: string | null;
    leaseTtlSeconds: number;
  }>
> => {
  if (
    typeof failoverMode !== 'string' ||
    !FAILOVER_MODES.includes(failoverMode)
  ) {
    return {
      valid: false,
      problems: ['failoverMode must be "manual" or "witness"'],
    };
  }

  const witness = failoverMode === 'witness';
  const witnessProblem = ((): string | undefined => {
    if (!witness) {
      return witnessUrl === undefined || witnessUrl === null
        ? undefined
        : 'witnessUrl is only accepted with failoverMode "witness"';
    }

    return typeof witnessUrl === 'string' &&
      normalizeWitnessUrl(witnessUrl) !== null
      ? undefined
      : 'witnessUrl is required with failoverMode "witness" and must be an http:// or https:// URL';
  })();
  const ttl = leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
  const ttlProblem =
    Number.isInteger(ttl) &&
    (ttl as number) >= MIN_LEASE_TTL_SECONDS &&
    (ttl as number) <= MAX_LEASE_TTL_SECONDS
      ? undefined
      : `leaseTtlSeconds must be an integer from ${MIN_LEASE_TTL_SECONDS} to ${MAX_LEASE_TTL_SECONDS}`;
  const problems = [witnessProblem, ttlProblem].filter(
    (problem): problem is string => problem !== undefined,
  );

  return problems.length > 0
    ? { valid: false, problems }
    : {
        valid: true,
        value: {
          failoverMode: failoverMode as FailoverMode,
          witnessUrl: witness ? (witnessUrl as string).trim() : null,
          leaseTtlSeconds: ttl as number,
        },
      };
};

/**
 * Checks what Core Hub would refuse at start, so that a bad request is
 * answered before anything is written: a Core Hub that cannot read its
 * settings does not start.
 */
export const validateFirstSiteRequest: ValidateFirstSiteRequest = request => {
  if (!isRecord(request)) {
    return { valid: false, problems: ['the body must be an object'] };
  }

  const thisSite = validateSite('thisSite', request.thisSite);
  const peerSite = validateSite('peerSite', request.peerSite);
  const failover = validateFailover(
    request.failoverMode,
    request.witnessUrl,
    request.leaseTtlSeconds,
  );

  const distinctProblem =
    thisSite.valid &&
    peerSite.valid &&
    (thisSite.value.nodeId === peerSite.value.nodeId ||
      thisSite.value.url === peerSite.value.url)
      ? [
          thisSite.value.nodeId === peerSite.value.nodeId
            ? 'thisSite.nodeId and peerSite.nodeId must be different'
            : 'thisSite.url and peerSite.url must be different',
        ]
      : [];

  const problems = [
    ...(thisSite.valid ? [] : thisSite.problems),
    ...(peerSite.valid ? [] : peerSite.problems),
    ...(failover.valid ? [] : failover.problems),
    ...distinctProblem,
  ];

  return thisSite.valid &&
    peerSite.valid &&
    failover.valid &&
    problems.length === 0
    ? {
        valid: true,
        value: {
          thisSite: thisSite.value,
          peerSite: peerSite.value,
          ...failover.value,
        },
      }
    : { valid: false, problems };
};

/** `GSDR1.` + base64url(JSON payload). The payload contains the shared secret of the pair. */
export const encodePairingCode: EncodePairingCode = payload =>
  `${PAIRING_CODE_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;

const parsePayload = (code: string): unknown => {
  const body = code.slice(PAIRING_CODE_PREFIX.length);

  if (!BASE64URL.test(body)) {
    throw new PairingCodeError('The pairing code is not valid');
  }

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new PairingCodeError('The pairing code is not valid');
  }
};

const decodedSite = (label: string, site: unknown): DisasterRecoverySite => {
  const result = validateSite(label, site);

  if (!result.valid) {
    throw new PairingCodeError('The pairing code is not valid');
  }

  return result.value;
};

/**
 * The inverse of encodePairingCode, checked as strictly as a first-site
 * request: a code the joining Core Hub would refuse is refused here.
 */
export const decodePairingCode: DecodePairingCode = code => {
  if (typeof code !== 'string' || !code.startsWith('GSDR')) {
    throw new PairingCodeError('The pairing code is not valid');
  }

  if (!code.startsWith(PAIRING_CODE_PREFIX)) {
    throw new PairingCodeError(
      'The pairing code is of a version this Conductor does not know: update it, or use a code from the same release',
    );
  }

  const payload = parsePayload(code);

  if (!isRecord(payload) || payload.v !== 1) {
    throw new PairingCodeError(
      'The pairing code is of a version this Conductor does not know: update it, or use a code from the same release',
    );
  }

  const { secret } = payload;
  const failover = validateFailover(
    payload.failoverMode,
    payload.witnessUrl,
    payload.leaseTtlSeconds,
  );
  const first = decodedSite('first', payload.first);
  const joiner = decodedSite('joiner', payload.joiner);

  if (
    typeof secret !== 'string' ||
    !SECRET.test(secret) ||
    !failover.valid ||
    first.nodeId === joiner.nodeId
  ) {
    throw new PairingCodeError('The pairing code is not valid');
  }

  return {
    v: 1,
    secret,
    ...failover.value,
    first,
    joiner,
  } satisfies PairingPayload;
};
