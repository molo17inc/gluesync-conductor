import { ProbeOutcome, ProbeResult } from './probe.model';

export type StatusFeedState = 'ok' | 'down' | 'stale' | 'unavailable';

export type StatusFeedResult = Readonly<{
  state: StatusFeedState;
  /** The probe, with `healthy` and `detail` rewritten to describe the feed's verdict. */
  probe: ProbeResult;
  reason?: string;
  ageMinutes?: number;
}>;

export type StatusFeedOptions = Readonly<{
  serviceId: string;
  staleAfterMs: number;
  now: number;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseJson = (body: string | undefined): unknown => {
  try {
    return body === undefined ? undefined : JSON.parse(body);
  } catch {
    return undefined;
  }
};

const findService = (
  feed: unknown,
  serviceId: string,
): Record<string, unknown> | undefined => {
  if (!isRecord(feed) || !Array.isArray(feed.groups)) {
    return undefined;
  }

  return feed.groups
    .flatMap(group =>
      isRecord(group) && Array.isArray(group.services) ? group.services : [],
    )
    .find(
      (service): service is Record<string, unknown> =>
        isRecord(service) && service.id === serviceId,
    );
};

const withVerdict = (
  probe: ProbeResult,
  state: StatusFeedState,
  detail: string,
  extra: Partial<StatusFeedResult> = {},
): StatusFeedResult => ({
  state,
  probe: { ...probe, healthy: state === 'ok', detail },
  ...extra,
});

/**
 * Reads the public status feed defensively: a feed that is unreachable, changed
 * shape, or is too old is reported as such. It is never an exception, and a
 * stale feed is never taken as proof that MOLO17 is healthy.
 */
export const interpretStatusFeed = (
  outcome: ProbeOutcome,
  { serviceId, staleAfterMs, now }: StatusFeedOptions,
): StatusFeedResult => {
  const { result } = outcome;

  if (!result.reachable) {
    return withVerdict(result, 'unavailable', `unreachable: ${result.detail}`);
  }

  const answeredOk =
    result.httpStatus !== undefined &&
    result.httpStatus >= 200 &&
    result.httpStatus < 300;

  if (!answeredOk) {
    return withVerdict(result, 'unavailable', `${result.detail}`);
  }

  const feed = parseJson(outcome.body);
  const service = findService(feed, serviceId);

  if (!service || typeof service.ok !== 'boolean') {
    return withVerdict(
      result,
      'unavailable',
      `no usable "${serviceId}" entry in the feed`,
    );
  }

  const runAt = isRecord(feed) ? Date.parse(String(feed.runAt)) : Number.NaN;
  const ageMs = Number.isNaN(runAt) ? undefined : now - runAt;
  const ageMinutes =
    ageMs === undefined ? undefined : Math.round(ageMs / 60_000);
  const age = ageMinutes === undefined ? '' : `, checked ${ageMinutes} min ago`;

  if (ageMs !== undefined && ageMs > staleAfterMs) {
    return withVerdict(result, 'stale', `feed is stale${age}`, { ageMinutes });
  }

  if (service.ok) {
    return withVerdict(result, 'ok', `${serviceId} reported ok${age}`, {
      ageMinutes,
    });
  }

  const reason =
    typeof service.reason === 'string' && service.reason !== ''
      ? service.reason
      : undefined;

  return withVerdict(
    result,
    'down',
    `${serviceId} reported down${reason ? `: ${reason}` : ''}${age}`,
    { reason, ageMinutes },
  );
};
