import axios, { AxiosError } from 'axios';
import { redactSecrets } from '../utils/redact';
import { getLogger } from '../utils/logger';
import { PRODUCTION_BACKOFFICE_URL, getDiagnosisConfig } from './config';
import { Diagnosis } from './diagnosis.model';
import { DIAGNOSIS_CATALOG } from './diagnosisCatalog';
import {
  classifyProbeError,
  describeFailure,
  detectOrigin,
} from './probes/classifyProbeError';
import { ProbeResult } from './probes/probe.model';
import runConnectivityCheck, {
  RunConnectivityCheck,
} from './runConnectivityCheck';

export type OutboundErrorBody = Readonly<{
  success: false;
  /** English title, kept in `error` so consumers that predate `diagnosis` still read something useful. */
  error: string;
  details?: string;
  diagnosis: Diagnosis;
}>;

export type OutboundErrorReply = Readonly<{
  statusCode: number;
  body: OutboundErrorBody;
}>;

export type OutboundErrorDeps = Readonly<{
  runConnectivityCheck: RunConnectivityCheck;
}>;

export type OutboundErrorOptions = Readonly<{
  /**
   * Upstream statuses that are an answer for this caller, not a failure to
   * explain. They are left to the caller's own handling.
   */
  passThroughStatuses?: ReadonlyArray<number>;
}>;

const logger = getLogger();

const hostOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Only failures of requests to MOLO17's own services are diagnosed. An axios
 * error from Core Hub or anything else must keep its own handling: blaming
 * the customer's network for it would be wrong.
 */
export const isMolo17OutboundError = (error: unknown): error is AxiosError => {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const config = getDiagnosisConfig();
  const host = hostOf(error.config?.url);

  // The OTA requests always go to the production backoffice, whatever
  // GLUESYNC_BACKOFFICE_URL says (that only moves the probe, for tests).
  return (
    host !== undefined &&
    [PRODUCTION_BACKOFFICE_URL, config.backofficeBaseUrl, config.statusApiUrl]
      .map(hostOf)
      .includes(host)
  );
};

const toTrigger = (error: Readonly<AxiosError>): ProbeResult => {
  const failure = classifyProbeError(error);
  const reachable = failure.httpStatus !== undefined;

  return {
    id: 'trigger',
    reachable,
    healthy: false,
    ms: 0,
    httpStatus: failure.httpStatus,
    errorKind: failure.kind,
    errorCode: failure.code,
    origin: reachable ? detectOrigin(failure.headers) : undefined,
    host: hostOf(error.config?.url),
    detail: describeFailure(failure),
  };
};

const defaultDeps: OutboundErrorDeps = { runConnectivityCheck };

/**
 * Turns a failed request to a MOLO17 service into the reply Conductor sends:
 * a status code that reflects who is at fault, a readable `error`, the raw
 * (credential-free) `details`, and the structured `diagnosis`.
 * Returns undefined when the error is not ours to diagnose, so callers keep
 * their existing handling.
 */
const buildOutboundErrorReply = async (
  error: unknown,
  deps: OutboundErrorDeps = defaultDeps,
  options: OutboundErrorOptions = {},
): Promise<OutboundErrorReply | undefined> => {
  if (
    !isMolo17OutboundError(error) ||
    (error.response !== undefined &&
      (options.passThroughStatuses ?? []).includes(error.response.status))
  ) {
    return undefined;
  }

  try {
    const diagnosis = await deps.runConnectivityCheck({
      trigger: toTrigger(error),
      refresh: true,
    });
    const { httpStatus } = DIAGNOSIS_CATALOG[diagnosis.code];

    return {
      // A failing request is never answered with a 2xx.
      statusCode: httpStatus >= 400 ? httpStatus : 502,
      body: {
        success: false,
        error: diagnosis.fallback.title,
        details: redactSecrets(error.message),
        diagnosis,
      },
    };
  } catch (diagnosisError) {
    logger.warn(
      { error: diagnosisError },
      '[diagnosis] could not diagnose outbound error, using default handling',
    );
    return undefined;
  }
};

export default buildOutboundErrorReply;
