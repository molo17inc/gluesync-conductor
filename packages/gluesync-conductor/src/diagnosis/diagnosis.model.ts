/**
 * Diagnosis contract (v1).
 *
 * Conductor owns this contract. Consumers (the Core Hub UI, support tooling,
 * other services) MUST treat it as a tolerant reader: ignore unknown fields,
 * and fall back to `fallback` for a `code` they do not know.
 *
 * Rules for changing it: additive only, codes are never renamed or reused,
 * `schemaVersion` is bumped only for breaking changes.
 */
export const DIAGNOSIS_SCHEMA_VERSION = 1;

export const DIAGNOSIS_CODES = [
  'CONNECTIVITY_OK',
  'TRANSIENT_FAILURE',
  'CONDUCTOR_UPDATING',
  'DOCKER_NOT_READY',
  'COREHUB_UNAVAILABLE',
  'PROXY_UNREACHABLE',
  'PROXY_AUTH_REQUIRED',
  'NO_INTERNET',
  'DNS_FAILURE',
  'TLS_INSPECTION',
  'MOLO17_HOSTS_BLOCKED',
  'BACKOFFICE_UNREACHABLE_FROM_HOST',
  'REGISTRY_UNREACHABLE',
  'UNEXPECTED_RESPONSE_FROM_INTERMEDIARY',
  'OTA_SERVICE_DOWN',
  'BACKOFFICE_REQUEST_REJECTED',
  'UNKNOWN',
  'DISK_FULL',
  'COMPOSE_FILE_CORRUPT',
  'SWARM_NOT_MANAGER',
  'SWARM_UNSUPPORTED',
] as const;

export type DiagnosisCode = (typeof DIAGNOSIS_CODES)[number];

/** Who has to act: the customer's environment, MOLO17's services, or this install. */
export const DIAGNOSIS_OWNERS = [
  'none',
  'customer',
  'molo17',
  'local',
  'unknown',
] as const;

export type DiagnosisOwner = (typeof DIAGNOSIS_OWNERS)[number];

export const DIAGNOSIS_CONFIDENCES = ['high', 'medium', 'low'] as const;

export type DiagnosisConfidence = (typeof DIAGNOSIS_CONFIDENCES)[number];

export const RESOLUTION_CODES = [
  'WAIT_AND_RETRY',
  'CHECK_STATUS_PAGE',
  'WAIT_FOR_CONDUCTOR_UPDATE',
  'CHECK_DOCKER_DAEMON',
  'CHECK_COREHUB_RUNNING',
  'CHECK_INTERNET_CONNECTION',
  'CHECK_DNS_SETTINGS',
  'ALLOWLIST_MOLO17_HOSTS',
  'CHECK_PROXY_SETTINGS',
  'CHECK_PROXY_CREDENTIALS',
  'TRUST_CORPORATE_CA',
  'CHECK_DOCKER_HUB_ACCESS',
  'CONTACT_SUPPORT_WITH_DETAILS',
  'FREE_DISK_SPACE',
  'RUN_CONDUCTOR_ON_SWARM_MANAGER',
] as const;

export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

export const CHECK_IDS = [
  'proxy',
  'internet-ip',
  'internet-name',
  'backoffice',
  'status-feed',
  'registry',
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export type DiagnosisParamValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string>;

export type DiagnosisParams = Readonly<Record<string, DiagnosisParamValue>>;

export type DiagnosisCheck = Readonly<{
  id: CheckId;
  ok: boolean;
  ms?: number;
  detail?: string;
}>;

/** English text for logs, curl users, old UIs and codes a consumer does not know. */
export type DiagnosisFallback = Readonly<{
  title: string;
  summary: string;
  steps: ReadonlyArray<string>;
}>;

export type Diagnosis = Readonly<{
  schemaVersion: typeof DIAGNOSIS_SCHEMA_VERSION;
  code: DiagnosisCode;
  owner: DiagnosisOwner;
  confidence: DiagnosisConfidence;
  params: DiagnosisParams;
  resolutionCodes: ReadonlyArray<ResolutionCode>;
  fallback: DiagnosisFallback;
  checks: ReadonlyArray<DiagnosisCheck>;
  source: Readonly<{ service: string; version?: string }>;
  at: string;
}>;
