import axios from 'axios';
import { redactSecrets } from '../../utils/redact';
import { ProbeErrorKind, ResponseOrigin } from './probe.model';

export type ProbeFailure = Readonly<{
  kind?: ProbeErrorKind;
  code?: string;
  httpStatus?: number;
  headers: Readonly<Record<string, string>>;
  message: string;
}>;

const TLS_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);

const DNS_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN']);

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ERR_CANCELED',
]);

const RESET_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'ERR_BAD_REQUEST_SOCKET',
]);

// Headers that only MOLO17's own edge adds. Present on a response means MOLO17
// answered, even when a transparent proxy relayed it.
const MOLO17_EDGE_HEADERS: ReadonlyArray<string> = [
  'x-amz-apigw-id',
  'x-amzn-requestid',
  'x-amz-cf-id',
];

const kindFromCode = (code: string | undefined): ProbeErrorKind => {
  if (code === undefined) {
    return 'other';
  }
  if (TLS_CODES.has(code) || code.startsWith('ERR_TLS')) {
    return 'tls';
  }
  if (DNS_CODES.has(code)) {
    return 'dns';
  }
  if (code === 'ECONNREFUSED') {
    return 'refused';
  }
  if (TIMEOUT_CODES.has(code)) {
    return 'timeout';
  }
  if (RESET_CODES.has(code)) {
    return 'reset';
  }
  return 'other';
};

export const normalizeHeaders = (
  raw: unknown,
): Readonly<Record<string, string>> => {
  const plain =
    raw && typeof (raw as { toJSON?: unknown }).toJSON === 'function'
      ? (raw as { toJSON: () => unknown }).toJSON()
      : raw;

  if (!plain || typeof plain !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(plain as Record<string, unknown>)
      .filter(
        ([, value]) => typeof value === 'string' || typeof value === 'number',
      )
      .map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
};

export const detectOrigin = (
  headers: Readonly<Record<string, string>>,
): ResponseOrigin =>
  MOLO17_EDGE_HEADERS.some(name => headers[name] !== undefined)
    ? 'molo17'
    : 'intermediary';

/**
 * Turns whatever a failed outbound request threw into the facts the rules use.
 * Based on the shapes axios actually produces, including a proxy answering
 * the CONNECT request (it surfaces as an error that carries a `response`).
 */
export const classifyProbeError = (error: unknown): ProbeFailure => {
  const code =
    error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
  const codeText = typeof code === 'string' ? code : undefined;
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error),
  );

  if (axios.isAxiosError(error) && error.response) {
    const httpStatus = error.response.status;

    return {
      kind: httpStatus === 407 ? 'proxy-auth' : undefined,
      code: codeText,
      httpStatus,
      headers: normalizeHeaders(error.response.headers),
      message,
    };
  }

  const messageSuggestsTls = /certificate|self[- ]signed/i.test(message);
  const kind = kindFromCode(codeText);

  return {
    kind: kind === 'other' && messageSuggestsTls ? 'tls' : kind,
    code: codeText,
    headers: {},
    message,
  };
};

export const describeFailure = (failure: ProbeFailure): string => {
  if (failure.kind === 'proxy-auth') {
    return 'proxy authentication required (HTTP 407)';
  }
  if (failure.httpStatus !== undefined) {
    return `HTTP ${failure.httpStatus}`;
  }
  return [failure.kind, failure.code && `(${failure.code})`]
    .filter(Boolean)
    .join(' ');
};
