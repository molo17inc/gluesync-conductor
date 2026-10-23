/* eslint-disable functional/immutable-data, functional/prefer-immutable-types, functional/no-let, functional/prefer-tacit */
// Test fixtures start servers and set environment variables, which is inherently imperative.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import runConnectivityCheck, {
  clearConnectivityCache,
} from './runConnectivityCheck';
import runHttpProbe from './probes/httpProbe';

type Reply = Readonly<{
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Never answer, to provoke a timeout. */
  hang?: boolean;
}>;

type Fixture = Readonly<{
  hits: () => Record<string, number>;
  baseUrl: (name: string) => string;
  stop: () => Promise<void>;
}>;

const ENV_KEYS = [
  'GLUESYNC_BACKOFFICE_URL',
  'GLUESYNC_STATUS_API_URL',
  'GLUESYNC_DIAGNOSIS_INTERNET_IP_URL',
  'GLUESYNC_DIAGNOSIS_INTERNET_NAME_URL',
  'GLUESYNC_DIAGNOSIS_REGISTRY_HOSTS',
  'GLUESYNC_DIAGNOSIS_TIMEOUT_MS',
];

const MOLO17_EDGE = { 'x-amz-cf-id': 'test-edge' };

const feedBody = (ok: boolean, reason = ''): string =>
  JSON.stringify({
    runAt: new Date().toISOString(),
    groups: [
      { id: 'g', services: [{ id: 'ota-update-services', ok, reason }] },
    ],
  });

const listen = (server: http.Server): Promise<number> =>
  new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as net.AddressInfo).port),
    );
  });

const closedPort = async (): Promise<number> => {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => {
    server.close(resolve);
  });
  return port;
};

// Starts one local server per dependency and points the config at them.
const startFixture = async (
  replies: Readonly<Record<string, Reply | 'refused'>>,
): Promise<Fixture> => {
  const counters: Record<string, number> = {};
  const servers: http.Server[] = [];
  const ports: Record<string, number> = {};

  await Promise.all(
    Object.entries(replies).map(async ([name, reply]) => {
      if (reply === 'refused') {
        ports[name] = await closedPort();
        return;
      }

      const server = http.createServer((_req, res) => {
        counters[name] = (counters[name] ?? 0) + 1;
        if (reply.hang) {
          return;
        }
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body ?? '');
      });
      servers.push(server);
      ports[name] = await listen(server);
    }),
  );

  const baseUrl = (name: string) => `http://127.0.0.1:${ports[name]}`;

  Object.assign(process.env, {
    GLUESYNC_BACKOFFICE_URL: baseUrl('backoffice'),
    GLUESYNC_STATUS_API_URL: `${baseUrl('status')}/status`,
    GLUESYNC_DIAGNOSIS_INTERNET_IP_URL: `${baseUrl('internetIp')}/trace`,
    GLUESYNC_DIAGNOSIS_INTERNET_NAME_URL: `${baseUrl('internetName')}/204`,
    GLUESYNC_DIAGNOSIS_REGISTRY_HOSTS: baseUrl('registry'),
    GLUESYNC_DIAGNOSIS_TIMEOUT_MS: '700',
  });

  return {
    hits: () => ({ ...counters }),
    baseUrl,
    stop: () =>
      Promise.all(
        servers.map(
          server =>
            new Promise(resolve => {
              server.closeAllConnections();
              server.close(resolve);
            }),
        ),
      ).then(() => undefined),
  };
};

const healthyReplies = {
  backoffice: { status: 200, headers: MOLO17_EDGE, body: '{}' },
  status: { status: 200, body: feedBody(true) },
  internetIp: { status: 200 },
  internetName: { status: 204 },
  registry: { status: 401 },
} as const;

describe('runConnectivityCheck (real probes against local servers)', () => {
  let fixture: Fixture | undefined;

  beforeEach(() => clearConnectivityCache());

  afterEach(async () => {
    await fixture?.stop();
    fixture = undefined;
    ENV_KEYS.forEach(key => {
      delete process.env[key];
    });
  });

  it('reports CONNECTIVITY_OK with every check passing', async () => {
    fixture = await startFixture(healthyReplies);

    const diagnosis = await runConnectivityCheck({ refresh: true });

    assert.equal(diagnosis.code, 'CONNECTIVITY_OK');
    assert.deepEqual(
      diagnosis.checks.map(check => [check.id, check.ok]).sort(),
      [
        ['backoffice', true],
        ['internet-ip', true],
        ['internet-name', true],
        ['registry', true],
        ['status-feed', true],
      ],
    );
  });

  it('shares one probe run between checks inside the cache window', async () => {
    fixture = await startFixture(healthyReplies);

    await runConnectivityCheck();
    await runConnectivityCheck();
    await runConnectivityCheck({ refresh: true }); // inside the minimum refresh interval

    assert.deepEqual(fixture.hits(), {
      backoffice: 1,
      status: 1,
      internetIp: 1,
      internetName: 1,
      registry: 1,
    });
  });

  it('probes again after the cache is cleared', async () => {
    fixture = await startFixture(healthyReplies);

    await runConnectivityCheck();
    clearConnectivityCache();
    await runConnectivityCheck();

    assert.equal(fixture.hits().backoffice, 2);
  });

  it('blames MOLO17 when its own edge answers 503', async () => {
    fixture = await startFixture({
      ...healthyReplies,
      backoffice: { status: 503, headers: MOLO17_EDGE },
    });

    const diagnosis = await runConnectivityCheck({ refresh: true });

    assert.equal(diagnosis.code, 'OTA_SERVICE_DOWN');
    assert.equal(diagnosis.owner, 'molo17');
  });

  it('blames the customer when a 503 comes without MOLO17 headers (a proxy in the way)', async () => {
    fixture = await startFixture({
      ...healthyReplies,
      backoffice: {
        status: 503,
        headers: { server: 'squid/5.7' },
        body: '<html>no</html>',
      },
    });

    const diagnosis = await runConnectivityCheck({ refresh: true });

    assert.equal(diagnosis.code, 'UNEXPECTED_RESPONSE_FROM_INTERMEDIARY');
    assert.equal(diagnosis.owner, 'customer');
    assert.equal(diagnosis.confidence, 'high');
  });

  it('says the host cannot reach the backoffice while MOLO17 reports fine', async () => {
    fixture = await startFixture({ ...healthyReplies, backoffice: 'refused' });

    const diagnosis = await runConnectivityCheck({ refresh: true });

    assert.equal(diagnosis.code, 'BACKOFFICE_UNREACHABLE_FROM_HOST');
    assert.equal(diagnosis.owner, 'customer');
    assert.equal(diagnosis.confidence, 'high');
  });

  it('reports the outage when the status feed says OTA is down but the backoffice answers', async () => {
    fixture = await startFixture({
      ...healthyReplies,
      status: { status: 200, body: feedBody(false, 'HTTP 502') },
    });

    const diagnosis = await runConnectivityCheck({ refresh: true });

    assert.equal(diagnosis.code, 'OTA_SERVICE_DOWN');
    assert.equal(diagnosis.confidence, 'medium');
  });

  it('flags MOLO17 hosts as blocked when only they are silent', async () => {
    fixture = await startFixture({
      ...healthyReplies,
      backoffice: 'refused',
      status: 'refused',
    });

    const diagnosis = await runConnectivityCheck({ refresh: true });

    assert.equal(diagnosis.code, 'MOLO17_HOSTS_BLOCKED');
  });

  it('flags the registry on its own', async () => {
    fixture = await startFixture({ ...healthyReplies, registry: 'refused' });

    const diagnosis = await runConnectivityCheck({ refresh: true });

    assert.equal(diagnosis.code, 'REGISTRY_UNREACHABLE');
  });

  it('does not call a registry healthy when a proxy refuses it with 403', async () => {
    fixture = await startFixture({
      ...healthyReplies,
      registry: { status: 403 },
    });

    const diagnosis = await runConnectivityCheck({ refresh: true });

    assert.equal(diagnosis.code, 'REGISTRY_UNREACHABLE');
    assert.equal(
      diagnosis.checks.find(check => check.id === 'registry')?.ok,
      false,
    );
  });

  it('survives a probe that never answers, within the configured timeout', async () => {
    fixture = await startFixture({
      ...healthyReplies,
      internetIp: { status: 200, hang: true },
    });
    const startedAt = Date.now();

    const diagnosis = await runConnectivityCheck({ refresh: true });

    assert.ok(
      Date.now() - startedAt < 3000,
      'a hanging probe must not stall the check',
    );
    assert.equal(diagnosis.code, 'CONNECTIVITY_OK');
    assert.equal(
      diagnosis.checks.find(check => check.id === 'internet-ip')?.ok,
      false,
    );
  });
});

describe('runHttpProbe', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    await fixture?.stop();
    fixture = undefined;
  });

  const spec = (url: string, expectMolo17Origin = false) => ({
    id: 'backoffice' as const,
    url,
    timeoutMs: 500,
    isHealthyStatus: (status: number) => status >= 200 && status < 300,
    expectMolo17Origin,
  });

  it('treats any HTTP answer as reachable and reports health separately', async () => {
    fixture = await startFixture({
      backoffice: { status: 503, headers: MOLO17_EDGE },
    });

    const { result } = await runHttpProbe(
      spec(fixture.baseUrl('backoffice'), true),
    );

    assert.equal(result.reachable, true);
    assert.equal(result.healthy, false);
    assert.equal(result.httpStatus, 503);
    assert.equal(result.origin, 'molo17');
  });

  it('classifies a refused connection', async () => {
    fixture = await startFixture({ backoffice: 'refused' });

    const { result } = await runHttpProbe(spec(fixture.baseUrl('backoffice')));

    assert.equal(result.reachable, false);
    assert.equal(result.errorKind, 'refused');
  });

  it('classifies a timeout', async () => {
    fixture = await startFixture({ backoffice: { status: 200, hang: true } });

    const { result } = await runHttpProbe(spec(fixture.baseUrl('backoffice')));

    assert.equal(result.reachable, false);
    assert.equal(result.errorKind, 'timeout');
  });

  it('classifies a name that does not resolve', async () => {
    const { result } = await runHttpProbe(
      spec('http://does-not-exist.invalid/'),
    );

    assert.equal(result.reachable, false);
    assert.equal(result.errorKind, 'dns');
  });

  it('never throws on a malformed URL', async () => {
    const { result } = await runHttpProbe(spec('not a url'));

    assert.equal(result.reachable, false);
  });
});
