import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import diagnose from './diagnose';
import { DIAGNOSIS_CODES } from './diagnosis.model';
import { DIAGNOSIS_CATALOG } from './diagnosisCatalog';
import { ProbeResult } from './probes/probe.model';
import { StatusFeedState, StatusFeedResult } from './probes/statusFeed';
import { ConnectivityFacts } from './rules/facts.model';

const NOW = () => new Date('2026-10-02T12:00:00.000Z');

const HOSTS = {
  'internet-ip': '1.1.1.1',
  'internet-name': 'www.google.com',
  backoffice: 'api.backoffice.molo17.com',
  'status-feed': 'status-api.example',
  registry: 'registry-1.docker.io',
  proxy: 'proxy.corp',
} as const;

type ProbeId = keyof typeof HOSTS;

const reachableProbe = (
  id: ProbeId,
  overrides: Partial<ProbeResult> = {},
): ProbeResult => ({
  id,
  reachable: true,
  healthy: true,
  ms: 50,
  httpStatus: 200,
  host: HOSTS[id],
  detail: 'HTTP 200',
  ...overrides,
});

const unreachableProbe = (
  id: ProbeId,
  errorKind: ProbeResult['errorKind'] = 'timeout',
): ProbeResult => ({
  id,
  reachable: false,
  healthy: false,
  ms: 4000,
  errorKind,
  host: HOSTS[id],
  detail: errorKind,
});

const feed = (state: StatusFeedState, reason?: string): StatusFeedResult => ({
  state,
  reason,
  probe:
    state === 'unavailable'
      ? { ...unreachableProbe('status-feed'), detail: 'unreachable' }
      : reachableProbe('status-feed', { healthy: state === 'ok' }),
});

// A healthy installation: everything answers, the status feed says ok.
const healthy = (
  overrides: Partial<ConnectivityFacts> = {},
): ConnectivityFacts => {
  const statusFeed = overrides.statusFeed ?? feed('ok');

  return {
    proxy: { configured: false },
    probes: [
      reachableProbe('internet-ip'),
      reachableProbe('internet-name'),
      reachableProbe('backoffice', { origin: 'molo17' }),
      reachableProbe('registry', { httpStatus: 401 }),
      statusFeed.probe,
    ],
    statusFeed,
    ...overrides,
  };
};

const trigger = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  id: 'trigger',
  reachable: false,
  healthy: false,
  ms: 0,
  host: HOSTS.backoffice,
  ...overrides,
});

const without = (facts: ConnectivityFacts, ids: ReadonlyArray<ProbeId>) =>
  facts.probes.filter(probe => !ids.includes(probe.id as ProbeId));

const run = (facts: ConnectivityFacts) => diagnose(facts, { now: NOW });

describe('diagnose: healthy and transient', () => {
  it('reports CONNECTIVITY_OK when every check passes', () => {
    const diagnosis = run(healthy());

    assert.equal(diagnosis.code, 'CONNECTIVITY_OK');
    assert.equal(diagnosis.owner, 'none');
    assert.equal(diagnosis.at, '2026-10-02T12:00:00.000Z');
  });

  it('reports TRANSIENT_FAILURE when a request failed but every check passes now', () => {
    const diagnosis = run(
      healthy({ trigger: trigger({ errorKind: 'timeout' }) }),
    );

    assert.equal(diagnosis.code, 'TRANSIENT_FAILURE');
    assert.equal(diagnosis.confidence, 'low');
    assert.deepEqual(diagnosis.params, { errorKind: 'timeout' });
  });

  it('does not call a locked-down network offline when MOLO17 answers', () => {
    const facts = healthy();
    const diagnosis = run({
      ...facts,
      probes: [
        unreachableProbe('internet-ip'),
        unreachableProbe('internet-name', 'dns'),
        ...without(facts, ['internet-ip', 'internet-name']),
      ],
    });

    assert.equal(diagnosis.code, 'CONNECTIVITY_OK');
  });
});

describe('diagnose: customer-side network', () => {
  it('PROXY_UNREACHABLE when the configured proxy refuses connections', () => {
    const facts = healthy({
      proxy: {
        configured: true,
        host: 'proxy.corp',
        port: 3128,
        reachable: false,
      },
    });
    const diagnosis = run({
      ...facts,
      probes: [unreachableProbe('proxy', 'refused'), ...facts.probes],
    });

    assert.equal(diagnosis.code, 'PROXY_UNREACHABLE');
    assert.equal(diagnosis.owner, 'customer');
    assert.deepEqual(diagnosis.params, { host: 'proxy.corp', port: 3128 });
  });

  it('PROXY_AUTH_REQUIRED when the proxy answers 407', () => {
    const facts = healthy();
    const diagnosis = run({
      ...facts,
      probes: [
        ...without(facts, ['backoffice']),
        reachableProbe('backoffice', {
          httpStatus: 407,
          errorKind: 'proxy-auth',
          healthy: false,
          origin: 'intermediary',
        }),
      ],
    });

    assert.equal(diagnosis.code, 'PROXY_AUTH_REQUIRED');
  });

  it('TLS_INSPECTION when the backoffice certificate is not trusted', () => {
    const facts = healthy();
    const diagnosis = run({
      ...facts,
      probes: [
        ...without(facts, ['backoffice']),
        unreachableProbe('backoffice', 'tls'),
      ],
    });

    assert.equal(diagnosis.code, 'TLS_INSPECTION');
    assert.deepEqual(diagnosis.params, { host: 'api.backoffice.molo17.com' });
  });

  it('NO_INTERNET when neither the address nor the name check connects, and MOLO17 is silent', () => {
    const diagnosis = run({
      proxy: { configured: false },
      probes: [
        unreachableProbe('internet-ip'),
        unreachableProbe('internet-name'),
        unreachableProbe('backoffice'),
        unreachableProbe('status-feed'),
      ],
      statusFeed: feed('unavailable'),
    });

    assert.equal(diagnosis.code, 'NO_INTERNET');
    assert.equal(diagnosis.confidence, 'high');
  });

  it('is less sure about NO_INTERNET behind a proxy', () => {
    const diagnosis = run({
      proxy: {
        configured: true,
        host: 'proxy.corp',
        port: 3128,
        reachable: true,
      },
      probes: [
        unreachableProbe('internet-ip'),
        unreachableProbe('internet-name'),
        unreachableProbe('backoffice'),
        unreachableProbe('status-feed'),
      ],
      statusFeed: feed('unavailable'),
    });

    assert.equal(diagnosis.code, 'NO_INTERNET');
    assert.equal(diagnosis.confidence, 'medium');
    assert.deepEqual(diagnosis.params, { viaProxy: true });
  });

  it('DNS_FAILURE when the address works but names do not resolve', () => {
    const diagnosis = run({
      proxy: { configured: false },
      probes: [
        reachableProbe('internet-ip'),
        unreachableProbe('internet-name', 'dns'),
        unreachableProbe('backoffice', 'dns'),
        unreachableProbe('status-feed', 'dns'),
      ],
      statusFeed: feed('unavailable'),
    });

    assert.equal(diagnosis.code, 'DNS_FAILURE');
    assert.deepEqual(diagnosis.params, { host: 'www.google.com' });
  });

  it('MOLO17_HOSTS_BLOCKED when the internet works but MOLO17 does not answer', () => {
    const diagnosis = run({
      proxy: { configured: false },
      probes: [
        reachableProbe('internet-ip'),
        reachableProbe('internet-name'),
        unreachableProbe('backoffice'),
        unreachableProbe('status-feed'),
      ],
      statusFeed: feed('unavailable'),
    });

    assert.equal(diagnosis.code, 'MOLO17_HOSTS_BLOCKED');
    // Only the host an update needs is named. The status feed is Conductor's own
    // aid, so its address is never put in front of the customer.
    assert.deepEqual(diagnosis.params, {
      hosts: ['api.backoffice.molo17.com'],
    });
    assert.ok(!JSON.stringify(diagnosis).includes('status-api.example'));
  });

  it('is only medium sure of MOLO17_HOSTS_BLOCKED when every MOLO17 check timed out', () => {
    const diagnosis = run({
      proxy: { configured: false },
      probes: [
        reachableProbe('internet-ip'),
        reachableProbe('internet-name'),
        unreachableProbe('backoffice', 'timeout'),
        unreachableProbe('status-feed', 'timeout'),
      ],
      statusFeed: feed('unavailable'),
    });

    // A firewall dropping packets and an outage of MOLO17's hosts look the same.
    assert.equal(diagnosis.code, 'MOLO17_HOSTS_BLOCKED');
    assert.equal(diagnosis.confidence, 'medium');
  });

  it('is sure of MOLO17_HOSTS_BLOCKED when a MOLO17 connection was refused or reset', () => {
    const diagnosis = run({
      proxy: { configured: false },
      probes: [
        reachableProbe('internet-ip'),
        reachableProbe('internet-name'),
        unreachableProbe('backoffice', 'reset'),
        unreachableProbe('status-feed', 'timeout'),
      ],
      statusFeed: feed('unavailable'),
    });

    assert.equal(diagnosis.code, 'MOLO17_HOSTS_BLOCKED');
    assert.equal(diagnosis.confidence, 'high');
  });

  it('BACKOFFICE_UNREACHABLE_FROM_HOST when only the backoffice is silent: high confidence with a fresh feed', () => {
    const facts = healthy();
    const diagnosis = run({
      ...facts,
      probes: [
        ...without(facts, ['backoffice']),
        unreachableProbe('backoffice'),
      ],
    });

    assert.equal(diagnosis.code, 'BACKOFFICE_UNREACHABLE_FROM_HOST');
    assert.equal(diagnosis.confidence, 'high');
  });

  it('is only medium sure when the status feed is too old to vouch for MOLO17', () => {
    const stale = feed('stale');
    const facts = healthy({ statusFeed: stale });
    const diagnosis = run({
      ...facts,
      probes: [
        ...without(facts, ['backoffice']),
        unreachableProbe('backoffice'),
      ],
    });

    assert.equal(diagnosis.code, 'BACKOFFICE_UNREACHABLE_FROM_HOST');
    assert.equal(diagnosis.confidence, 'medium');
  });

  it('REGISTRY_UNREACHABLE when something answers the registry with 403', () => {
    const facts = healthy();
    const diagnosis = run({
      ...facts,
      probes: [
        ...without(facts, ['registry']),
        reachableProbe('registry', { httpStatus: 403, healthy: false }),
      ],
    });

    assert.equal(diagnosis.code, 'REGISTRY_UNREACHABLE');
  });

  it('REGISTRY_UNREACHABLE when only the image registry is silent', () => {
    const facts = healthy();
    const diagnosis = run({
      ...facts,
      probes: [...without(facts, ['registry']), unreachableProbe('registry')],
    });

    assert.equal(diagnosis.code, 'REGISTRY_UNREACHABLE');
    assert.deepEqual(diagnosis.params, { host: 'registry-1.docker.io' });
  });
});

describe('diagnose: who answered decides who is at fault', () => {
  it('OTA_SERVICE_DOWN when MOLO17 itself answered 503', () => {
    const diagnosis = run(
      healthy({
        trigger: trigger({
          reachable: true,
          httpStatus: 503,
          origin: 'molo17',
        }),
      }),
    );

    assert.equal(diagnosis.code, 'OTA_SERVICE_DOWN');
    assert.equal(diagnosis.owner, 'molo17');
    assert.equal(diagnosis.confidence, 'high');
  });

  // The bug this work exists to fix: a customer proxy's 503 used to be shown as
  // "OTA is under maintenance, check the status page".
  it('UNEXPECTED_RESPONSE_FROM_INTERMEDIARY when a 503 carries no MOLO17 headers', () => {
    const diagnosis = run(
      healthy({
        trigger: trigger({
          reachable: true,
          httpStatus: 503,
          origin: 'intermediary',
        }),
      }),
    );

    assert.equal(diagnosis.code, 'UNEXPECTED_RESPONSE_FROM_INTERMEDIARY');
    assert.equal(diagnosis.owner, 'customer');
    assert.equal(diagnosis.confidence, 'high');
  });

  it('is only medium sure of that when the status feed cannot confirm MOLO17 is fine', () => {
    const diagnosis = run(
      healthy({
        statusFeed: feed('unavailable'),
        trigger: trigger({
          reachable: true,
          httpStatus: 503,
          origin: 'intermediary',
        }),
      }),
    );

    assert.equal(diagnosis.code, 'UNEXPECTED_RESPONSE_FROM_INTERMEDIARY');
    assert.equal(diagnosis.confidence, 'medium');
  });

  it('BACKOFFICE_REQUEST_REJECTED when MOLO17 answered a 404', () => {
    const diagnosis = run(
      healthy({
        trigger: trigger({
          reachable: true,
          httpStatus: 404,
          origin: 'molo17',
        }),
      }),
    );

    assert.equal(diagnosis.code, 'BACKOFFICE_REQUEST_REJECTED');
    assert.equal(diagnosis.owner, 'molo17');
    assert.equal(diagnosis.fallback.steps.length, 1);
  });

  // MOLO17's own feed says OTA is down: a failure that could be either side's
  // must not be put on the customer.
  it('OTA_SERVICE_DOWN, not the customer, when the backoffice is silent and the feed reports the outage', () => {
    const facts = healthy({ statusFeed: feed('down', 'HTTP 502') });
    const diagnosis = run({
      ...facts,
      probes: [
        ...without(facts, ['backoffice']),
        unreachableProbe('backoffice'),
      ],
    });

    assert.equal(diagnosis.code, 'OTA_SERVICE_DOWN');
    assert.equal(diagnosis.owner, 'molo17');
  });

  it('OTA_SERVICE_DOWN, not the customer, when a proxy answers 503 and the feed reports the outage', () => {
    const diagnosis = run(
      healthy({
        proxy: {
          configured: true,
          host: 'proxy.corp',
          port: 3128,
          reachable: true,
        },
        statusFeed: feed('down', 'HTTP 502'),
        trigger: trigger({
          reachable: true,
          httpStatus: 503,
          origin: 'intermediary',
        }),
      }),
    );

    assert.equal(diagnosis.code, 'OTA_SERVICE_DOWN');
    assert.equal(diagnosis.owner, 'molo17');
  });

  it('still trusts MOLO17 headers over the feed: a 404 from MOLO17 is a rejected request', () => {
    const diagnosis = run(
      healthy({
        statusFeed: feed('down', 'HTTP 502'),
        trigger: trigger({
          reachable: true,
          httpStatus: 404,
          origin: 'molo17',
        }),
      }),
    );

    assert.equal(diagnosis.code, 'BACKOFFICE_REQUEST_REJECTED');
  });

  it('OTA_SERVICE_DOWN, medium, when only the status feed reports the outage', () => {
    const diagnosis = run(healthy({ statusFeed: feed('down', 'HTTP 502') }));

    assert.equal(diagnosis.code, 'OTA_SERVICE_DOWN');
    assert.equal(diagnosis.confidence, 'medium');
    assert.deepEqual(diagnosis.params, {
      host: 'api.backoffice.molo17.com',
      reason: 'HTTP 502',
    });
  });
});

describe('diagnose: structure', () => {
  it('first matching stage wins: an unreachable proxy outranks everything behind it', () => {
    const diagnosis = run({
      proxy: {
        configured: true,
        host: 'proxy.corp',
        port: 3128,
        reachable: false,
      },
      probes: [
        unreachableProbe('proxy', 'refused'),
        unreachableProbe('internet-ip'),
        unreachableProbe('internet-name'),
        unreachableProbe('backoffice'),
        unreachableProbe('status-feed'),
      ],
      statusFeed: feed('unavailable'),
    });

    assert.equal(diagnosis.code, 'PROXY_UNREACHABLE');
  });

  it('falls back to UNKNOWN when no stage recognises the situation', () => {
    const diagnosis = diagnose(
      { proxy: { configured: false }, probes: [] },
      { now: NOW },
    );

    assert.notEqual(diagnosis.code, 'CONNECTIVITY_OK');
    assert.ok(DIAGNOSIS_CODES.includes(diagnosis.code));
  });

  it('lists every probe as a check, never the triggering request', () => {
    const diagnosis = run(
      healthy({
        trigger: trigger({
          reachable: true,
          httpStatus: 503,
          origin: 'molo17',
        }),
      }),
    );

    assert.deepEqual(diagnosis.checks.map(check => check.id).sort(), [
      'backoffice',
      'internet-ip',
      'internet-name',
      'registry',
      'status-feed',
    ]);
    assert.ok(diagnosis.checks.every(check => typeof check.ok === 'boolean'));
  });

  it('takes owner, steps and fallback text from the catalog', () => {
    const diagnosis = run(healthy({ statusFeed: feed('down') }));
    const entry = DIAGNOSIS_CATALOG[diagnosis.code];

    assert.equal(diagnosis.owner, entry.owner);
    assert.deepEqual(diagnosis.resolutionCodes, entry.resolutionCodes);
    assert.equal(diagnosis.fallback.title, entry.title);
    assert.equal(diagnosis.fallback.steps.length, entry.resolutionCodes.length);
    assert.equal(diagnosis.schemaVersion, 1);
  });
});
