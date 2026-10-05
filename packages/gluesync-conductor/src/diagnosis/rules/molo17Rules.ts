import { ProbeResult } from '../probes/probe.model';
import { Rule, firstProbe, probesById } from './facts.model';

const isNon2xx = (probe: ProbeResult | undefined): probe is ProbeResult =>
  probe !== undefined &&
  probe.reachable &&
  probe.httpStatus !== undefined &&
  (probe.httpStatus < 200 || probe.httpStatus >= 300) &&
  probe.errorKind !== 'proxy-auth';

export const backofficeUnreachable: Rule = facts => {
  const backoffice = firstProbe(facts, 'backoffice');
  const statusFeed = firstProbe(facts, 'status-feed');

  if (backoffice?.reachable !== false || statusFeed?.reachable !== true) {
    return undefined;
  }

  return {
    code: 'BACKOFFICE_UNREACHABLE_FROM_HOST',
    // MOLO17's status feed answered, so MOLO17 is up and the gap is on this side.
    confidence: facts.statusFeed?.state === 'ok' ? 'high' : 'medium',
    params: { host: backoffice.host ?? '' },
  };
};

// Looks at the response itself. MOLO17's edge stamps its own headers, so a 503
// without them came from a proxy or firewall, not from MOLO17.
export const unexpectedResponse: Rule = facts => {
  const observed = [facts.trigger, firstProbe(facts, 'backoffice')].find(
    isNon2xx,
  );

  if (!observed || observed.httpStatus === undefined) {
    return undefined;
  }

  const params = {
    status: observed.httpStatus,
    host: observed.host ?? '',
  };

  if (observed.origin === 'molo17') {
    return observed.httpStatus >= 500
      ? { code: 'OTA_SERVICE_DOWN', confidence: 'high', params }
      : { code: 'BACKOFFICE_REQUEST_REJECTED', confidence: 'high', params };
  }

  return {
    code: 'UNEXPECTED_RESPONSE_FROM_INTERMEDIARY',
    confidence:
      observed.origin === 'intermediary' && facts.statusFeed?.state === 'ok'
        ? 'high'
        : 'medium',
    params: { status: observed.httpStatus, viaProxy: facts.proxy.configured },
  };
};

export const statusFeedReportsDown: Rule = facts =>
  facts.statusFeed?.state === 'down'
    ? {
        code: 'OTA_SERVICE_DOWN',
        confidence: 'medium',
        params: {
          host: firstProbe(facts, 'backoffice')?.host ?? '',
          ...(facts.statusFeed.reason
            ? { reason: facts.statusFeed.reason }
            : {}),
        },
      }
    : undefined;

// Silent, or answered with 403/407: something between this host and the
// registry refuses the request, so images cannot be pulled.
const registryRefused = (probe: ProbeResult): boolean =>
  !probe.reachable || probe.httpStatus === 403 || probe.httpStatus === 407;

export const registryUnreachable: Rule = facts => {
  const failing = probesById(facts, 'registry').find(registryRefused);

  return failing
    ? {
        code: 'REGISTRY_UNREACHABLE',
        confidence: 'high',
        params: { host: failing.host ?? '' },
      }
    : undefined;
};

// Every probe is fine but the real request failed a moment ago.
export const transientFailure: Rule = facts =>
  facts.trigger
    ? {
        code: 'TRANSIENT_FAILURE',
        confidence: 'low',
        params: { errorKind: facts.trigger.errorKind ?? 'unknown' },
      }
    : undefined;

export const allOk: Rule = () => ({
  code: 'CONNECTIVITY_OK',
  confidence: 'high',
});
