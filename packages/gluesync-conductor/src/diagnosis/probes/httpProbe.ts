import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { getHttpsAgentFor } from '../../utils/axiosWithRetry';
import { CheckId } from '../diagnosis.model';
import {
  classifyProbeError,
  describeFailure,
  detectOrigin,
  normalizeHeaders,
} from './classifyProbeError';
import { ProbeOutcome } from './probe.model';

// A probe target plus the predicate that says what healthy looks like for it.
// eslint-disable-next-line functional/no-mixed-types
export type HttpProbeSpec = Readonly<{
  id: CheckId;
  url: string;
  timeoutMs: number;
  /** What a healthy answer looks like for this target. */
  isHealthyStatus: (status: number) => boolean;
  /** Record whether the answer carries MOLO17's edge headers. */
  expectMolo17Origin?: boolean;
  captureBody?: boolean;
}>;

export type HttpProbeDeps = Readonly<{
  request: (config: Readonly<AxiosRequestConfig>) => Promise<AxiosResponse>;
  getAgent: (url: string) => AxiosRequestConfig['httpsAgent'];
  now: () => number;
}>;

const defaultDeps: HttpProbeDeps = {
  request: config => axios.request(config),
  getAgent: getHttpsAgentFor,
  now: () => Date.now(),
};

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

const MAX_BODY_BYTES = 1_000_000;

/**
 * One reachability probe. Never throws: every outcome, including a transport
 * failure, is returned as data so the rules can reason about it.
 * Any HTTP answer counts as "reachable"; `healthy` says whether it was the
 * answer a working service gives.
 */
const runHttpProbe = async (
  spec: HttpProbeSpec,
  deps: HttpProbeDeps = defaultDeps,
): Promise<ProbeOutcome> => {
  const startedAt = deps.now();
  const host = hostOf(spec.url);

  try {
    const response = await deps.request({
      url: spec.url,
      method: 'GET',
      timeout: spec.timeoutMs,
      // Hard stop in case a connect hangs below axios' idle timeout.
      signal: AbortSignal.timeout(spec.timeoutMs + 1000),
      proxy: false,
      httpsAgent: deps.getAgent(spec.url),
      validateStatus: () => true,
      maxRedirects: 0,
      responseType: 'text',
      transformResponse: [(data: unknown) => data],
      maxContentLength: MAX_BODY_BYTES,
      headers: { 'User-Agent': 'gluesync-conductor-connectivity-check' },
    });

    return {
      result: {
        id: spec.id,
        reachable: true,
        healthy: spec.isHealthyStatus(response.status),
        ms: deps.now() - startedAt,
        httpStatus: response.status,
        // https-proxy-agent hands a refused CONNECT back as an ordinary response,
        // and every status is accepted here, so a 407 never reaches the catch.
        ...(response.status === 407
          ? { errorKind: 'proxy-auth' as const }
          : {}),
        origin: spec.expectMolo17Origin
          ? detectOrigin(normalizeHeaders(response.headers))
          : undefined,
        host,
        detail: `HTTP ${response.status}`,
      },
      body: spec.captureBody ? String(response.data ?? '') : undefined,
    };
  } catch (error) {
    const failure = classifyProbeError(error);
    const reachable = failure.httpStatus !== undefined;

    return {
      result: {
        id: spec.id,
        reachable,
        healthy: false,
        ms: deps.now() - startedAt,
        httpStatus: failure.httpStatus,
        errorKind: failure.kind,
        errorCode: failure.code,
        origin:
          reachable && spec.expectMolo17Origin
            ? detectOrigin(failure.headers)
            : undefined,
        host,
        detail: describeFailure(failure),
      },
    };
  }
};

export default runHttpProbe;
