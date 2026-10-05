import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProbeOutcome, ProbeResult } from './probe.model';
import { interpretStatusFeed } from './statusFeed';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const OPTIONS = {
  serviceId: 'ota-update-services',
  staleAfterMs: 60 * 60_000,
  now: NOW,
};

const probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  id: 'status-feed',
  reachable: true,
  healthy: true,
  ms: 100,
  httpStatus: 200,
  host: 'status.example',
  detail: 'HTTP 200',
  ...overrides,
});

const feedBody = (
  service: Record<string, unknown> | undefined,
  runAt = '2026-10-02T11:45:00.000Z',
): string =>
  JSON.stringify({
    runAt,
    allOk: true,
    groups: [
      {
        id: 'gluesync',
        services: service
          ? [{ id: 'docs', ok: true }, service]
          : [{ id: 'docs', ok: true }],
      },
    ],
  });

const outcome = (body: string | undefined, result = probe()): ProbeOutcome => ({
  result,
  body,
});

describe('interpretStatusFeed', () => {
  it('reports ok when the OTA entry is ok and the feed is fresh', () => {
    const feed = interpretStatusFeed(
      outcome(feedBody({ id: 'ota-update-services', ok: true })),
      OPTIONS,
    );

    assert.equal(feed.state, 'ok');
    assert.equal(feed.probe.healthy, true);
    assert.equal(feed.ageMinutes, 15);
  });

  it('reports down with the reason the feed gives', () => {
    const feed = interpretStatusFeed(
      outcome(
        feedBody({ id: 'ota-update-services', ok: false, reason: 'HTTP 502' }),
      ),
      OPTIONS,
    );

    assert.equal(feed.state, 'down');
    assert.equal(feed.reason, 'HTTP 502');
    assert.equal(feed.probe.healthy, false);
  });

  it('does not trust an old feed, even one that says ok', () => {
    const feed = interpretStatusFeed(
      outcome(
        feedBody(
          { id: 'ota-update-services', ok: true },
          '2026-10-02T08:00:00.000Z',
        ),
      ),
      OPTIONS,
    );

    assert.equal(feed.state, 'stale');
    assert.equal(feed.probe.healthy, false);
  });

  it('is unavailable when the feed cannot be reached', () => {
    const feed = interpretStatusFeed(
      outcome(
        undefined,
        probe({
          reachable: false,
          healthy: false,
          httpStatus: undefined,
          detail: 'timeout (ECONNABORTED)',
        }),
      ),
      OPTIONS,
    );

    assert.equal(feed.state, 'unavailable');
    assert.match(feed.probe.detail ?? '', /unreachable/);
  });

  it('is unavailable on a non-2xx answer', () => {
    const feed = interpretStatusFeed(
      outcome(
        '<html>blocked</html>',
        probe({ httpStatus: 403, detail: 'HTTP 403' }),
      ),
      OPTIONS,
    );

    assert.equal(feed.state, 'unavailable');
  });

  it('is unavailable when the body is not JSON', () => {
    assert.equal(
      interpretStatusFeed(outcome('<html>captive portal</html>'), OPTIONS)
        .state,
      'unavailable',
    );
  });

  it('is unavailable when the feed changed shape or lacks the OTA entry', () => {
    assert.equal(
      interpretStatusFeed(outcome(feedBody(undefined)), OPTIONS).state,
      'unavailable',
    );
    assert.equal(
      interpretStatusFeed(outcome(JSON.stringify({ services: [] })), OPTIONS)
        .state,
      'unavailable',
    );
    assert.equal(
      interpretStatusFeed(
        outcome(feedBody({ id: 'ota-update-services', ok: 'yes' })),
        OPTIONS,
      ).state,
      'unavailable',
    );
  });

  it('still works when the feed has no usable timestamp', () => {
    const feed = interpretStatusFeed(
      outcome(feedBody({ id: 'ota-update-services', ok: true }, 'not a date')),
      OPTIONS,
    );

    assert.equal(feed.state, 'ok');
    assert.equal(feed.ageMinutes, undefined);
  });
});
