import { createHash, createHmac, randomBytes } from 'node:crypto';
import https from 'node:https';

import axios from 'axios';

import { getLogger } from '../../utils/logger';
import type {
  ProbeWitness,
  WitnessJoinRefusal,
  WitnessProbeDeps,
  WitnessWarnings,
} from './disasterRecoveryWitness.model';

/** The witness answers `GET /health` at once: a witness that does not in this time is not usable either. */
export const WITNESS_PROBE_TIMEOUT_MS = 3000;

// DrHmac.kt HEADER
const AUTH_HEADER = 'X-GS-DR-Auth';
const HEALTH_PATH = '/health';
// The signed read of a witness (DrWitnessServer.kt): it answers a node (HMAC) or the operator (bearer)
const LEASE_PATH = '/dr/lease';
const WITNESS_ROLE = 'witness';
const MAX_BODY_BYTES = 65_536;
// The nonce of DrHmac.kt: 16 random bytes as hex
const NONCE_BYTES = 16;
// DrHmac.kt MAX_SKEW_SECONDS
const MAX_SKEW_SECONDS = 60;

// A witness may sit behind a proxy with a certificate of its own, or serve the pair's self-signed one: like the nodes (DrPeerClient.kt)
// this accepts any certificate. Nothing secret travels in the probe: /health is open and the signature covers the request only.
const agent = new https.Agent({ rejectUnauthorized: false }); // NOSONAR

const defaultDeps: WitnessProbeDeps = {
  request: config => axios.request(config),
  nowSeconds: () => Math.floor(Date.now() / 1000),
  nonce: () => randomBytes(NONCE_BYTES).toString('hex'),
};

// What an operator can act on, instead of the raw code of axios
const reasonOf = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    switch (error.code) {
      case 'ECONNABORTED':
      case 'ETIMEDOUT':
      case 'ERR_CANCELED':
        return `no answer within ${WITNESS_PROBE_TIMEOUT_MS / 1000} s`;
      case 'ERR_BAD_RESPONSE':
        return 'answered something that is not a witness';
      default:
        return error.code ?? error.message;
    }
  }

  return error instanceof Error ? error.message : String(error);
};

// The path the witness sees: the one of the URL plus the route, as DrWitnessClient.kt signs it
const pathOf = (baseUrl: string, route: string): string => {
  try {
    return `${new URL(baseUrl).pathname.replace(/\/+$/, '')}${route}`;
  } catch {
    return route;
  }
};

const sha256Hex = (body: string): string =>
  createHash('sha256').update(body).digest('hex');

/** The value of the auth header of a `GET` with no body, as DrHmac.kt `sign` makes it and `verify` checks it. */
const signGet = (
  path: string,
  nodeId: string,
  secret: string,
  deps: WitnessProbeDeps,
): string => {
  const timestamp = String(deps.nowSeconds());
  const nonce = deps.nonce();
  const canonical = `request\n${timestamp}\n${nodeId}\n${nonce}\nGET\n${path}\n${sha256Hex('')}`;
  const signature = createHmac('sha256', secret)
    .update(canonical)
    .digest('hex');

  return `${timestamp}.${nodeId}.${nonce}.${signature}`;
};

const roleOf = (body: unknown): string | null => {
  try {
    const parsed: unknown = typeof body === 'string' ? JSON.parse(body) : body;
    const role =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { role?: unknown }).role
        : undefined;

    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
};

const get = async (
  url: string,
  headers: Readonly<Record<string, string>>,
  deps: WitnessProbeDeps,
): ReturnType<WitnessProbeDeps['request']> =>
  deps.request({
    url,
    method: 'GET',
    timeout: WITNESS_PROBE_TIMEOUT_MS,
    // Hard stop in case a connect hangs below the idle timeout of axios
    signal: AbortSignal.timeout(WITNESS_PROBE_TIMEOUT_MS + 1000),
    proxy: false,
    httpsAgent: agent,
    validateStatus: () => true,
    maxRedirects: 0,
    responseType: 'text',
    transformResponse: [(data: unknown) => data],
    maxContentLength: MAX_BODY_BYTES,
    headers,
  });

export const probeWitness: ProbeWitness = async (
  witnessUrl,
  credentials,
  deps = defaultDeps,
) => {
  const baseUrl = witnessUrl.trim().replace(/\/+$/, '');

  try {
    const health = await get(`${baseUrl}${HEALTH_PATH}`, {}, deps);

    if (health.status !== 200) {
      return { kind: 'unreachable', reason: `answered ${health.status}` };
    }

    const role = roleOf(health.data);

    if (role?.toLowerCase() !== WITNESS_ROLE) {
      return { kind: 'not-a-witness', role };
    }

    if (!credentials) {
      return { kind: 'answers' };
    }

    const lease = await get(
      `${baseUrl}${LEASE_PATH}`,
      {
        [AUTH_HEADER]: signGet(
          pathOf(baseUrl, LEASE_PATH),
          credentials.nodeId,
          credentials.secret,
          deps,
        ),
      },
      deps,
    );

    // A witness without the signed read (404) or one that fails for its own reasons is no proof either way: /health was enough
    return lease.status === 401 || lease.status === 403
      ? { kind: 'rejected' }
      : { kind: 'answers' };
  } catch (error) {
    getLogger().debug(
      { witnessUrl: baseUrl, reason: reasonOf(error) },
      '[disaster-recovery] the witness did not answer',
    );
    return { kind: 'unreachable', reason: reasonOf(error) };
  }
};

const describedRole = (role: string | null): string =>
  role === null
    ? 'something that is not a witness'
    : `a Core Hub with the role "${role}"`;

export const witnessWarnings: WitnessWarnings = (witnessUrl, probe) => {
  switch (probe.kind) {
    case 'unreachable':
    case 'rejected':
      return [
        `The witness at ${witnessUrl} does not answer yet. Start it with the shared secret of gluesync-dr.env: this site serves only once the witness answers or the second site joins.`,
      ];
    case 'not-a-witness':
      return [
        `The service at ${witnessUrl} answers as ${describedRole(probe.role)}, not as a witness. Point the witness URL at a Core Hub started with GS_DR_ROLE=witness and the shared secret of gluesync-dr.env.`,
      ];
    default:
      return [];
  }
};

export const witnessJoinRefusal: WitnessJoinRefusal = (
  witnessUrl,
  probe,
  nodeId,
) => {
  switch (probe.kind) {
    case 'unreachable':
      return {
        error: 'The witness does not answer',
        details: `The witness at ${witnessUrl} does not answer (${probe.reason}). It must be running with the shared secret of the pair before this site joins: start it, then join again.`,
      };
    case 'rejected':
      return {
        error: 'The witness refuses the shared secret of the pair',
        details: `The witness at ${witnessUrl} rejected the signature of this site. It must be running with the shared secret of the pair, the clocks of the hosts must agree within ${MAX_SKEW_SECONDS} seconds, and its node id (GS_DR_NODE_ID) must differ from the node id of this site, "${nodeId}".`,
      };
    case 'not-a-witness':
      return {
        error: 'The witness is not a witness',
        details: `The service at ${witnessUrl} answers as ${describedRole(probe.role)}. The witness must be a Core Hub started with GS_DR_ROLE=witness and the shared secret of the pair.`,
      };
    default:
      return null;
  }
};
