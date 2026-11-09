import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import fastify, {
  type FastifyInstance,
  type FastifyPluginCallback,
  type RouteHandlerMethod,
} from 'fastify';

import errorHandlerPlugin from '../plugins/errorHandlerPlugin';
import loadWithStubs from '../testing/loadWithStubs';

type Subject = Readonly<{ default: FastifyPluginCallback }>;

const fn = (p: string): string =>
  path.resolve(__dirname, '../functions/disasterRecovery', p);

type Calls = Record<string, unknown[]>;

const buildApp = async (replies: Record<string, unknown> = {}) => {
  const calls: Calls = {
    get: [],
    first: [],
    join: [],
    disable: [],
    pairing: [],
  };
  const handler =
    (name: string, code = 200): RouteHandlerMethod =>
    async (req, reply) => {
      calls[name].push(req.body);
      reply.code(code).send(replies[name]);
    };
  const subject = loadWithStubs<Subject>(
    path.resolve(__dirname, './disasterRecovery'),
    {
      [fn('getDisasterRecoverySetup/getDisasterRecoverySetup')]: {
        default: handler('get'),
      },
      [fn('setupFirstSite/setupFirstSite')]: { default: handler('first', 202) },
      [fn('getPairingCode/getPairingCode')]: {
        default: handler('pairing'),
      },
      [fn('joinSecondSite/joinSecondSite')]: { default: handler('join', 202) },
      [fn('disableDisasterRecovery/disableDisasterRecovery')]: {
        default: handler('disable', 202),
      },
      [path.resolve(__dirname, '../security')]: {
        // The real guard answers 403 for a role that may not modify the configuration.
        requireConfig: () => async (req: any, reply: any) => {
          if (req.headers['x-role'] === 'monitor') {
            reply.code(403).send({ success: false, error: 'Forbidden' });
          }
        },
      },
    },
  );
  const app = fastify();
  // Shapes validation errors like the Conductor does: { success: false, error, details }
  await app.register(errorHandlerPlugin);
  await app.register(subject.default);
  await app.ready();

  return { app, calls };
};

const send = (
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  role = 'manager',
) =>
  app.inject({
    method,
    url,
    headers: { 'x-role': role },
    payload: payload as Record<string, unknown>,
  });

const FIRST = {
  thisSite: { nodeId: 'site-a', url: 'http://10.0.0.1:1717' },
  peerSite: { nodeId: 'site-b', url: 'http://10.0.0.2:1717' },
  failoverMode: 'manual',
};

const STATE = {
  supported: true,
  reason: null,
  enabled: true,
  managedByConductor: true,
  nodeId: 'site-a',
  peerUrl: 'http://10.0.0.2:1717',
  failoverMode: 'manual',
  witnessUrl: null,
  bootstrapActive: true,
};

describe('disaster recovery routes', () => {
  it('guards every route with the role that may modify the configuration', async () => {
    const { app, calls } = await buildApp();
    const attempts = [
      send(app, 'GET', '/disaster-recovery/setup', undefined, 'monitor'),
      send(app, 'POST', '/disaster-recovery/setup/first', FIRST, 'monitor'),
      send(
        app,
        'POST',
        '/disaster-recovery/setup/join',
        { pairingCode: 'GSDR1.x', confirmDataMovedAside: true },
        'monitor',
      ),
      send(
        app,
        'POST',
        '/disaster-recovery/disable',
        { confirm: true },
        'monitor',
      ),
      send(
        app,
        'POST',
        '/disaster-recovery/setup/pairing-code',
        undefined,
        'monitor',
      ),
    ];

    (await Promise.all(attempts)).forEach(res =>
      assert.equal(res.statusCode, 403),
    );
    assert.deepEqual(calls, {
      get: [],
      first: [],
      join: [],
      disable: [],
      pairing: [],
    });
    await app.close();
  });

  it('GET /disaster-recovery/setup serves the state and drops anything that is not part of it', async () => {
    const { app } = await buildApp({
      get: {
        success: true,
        data: {
          ...STATE,
          sharedSecret: 'must-not-leave',
          adminToken: 'must-not-leave',
        },
      },
    });
    const res = await send(app, 'GET', '/disaster-recovery/setup');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { success: true, data: STATE });
    assert.ok(!res.body.includes('must-not-leave'));
    await app.close();
  });

  it('POST /disaster-recovery/setup/first takes the two sites and answers 202 with what the schema lists', async () => {
    const { app, calls } = await buildApp({
      first: {
        success: true,
        data: {
          pairingCode: 'GSDR1.abc',
          operatorToken: 'token',
          restarting: ['gluesync-core-hub', 'gluesync-chronos'],
          warnings: [
            'The witness at https://w.example.com does not answer yet.',
          ],
          internal: 'dropped',
        },
      },
    });
    const body = {
      ...FIRST,
      failoverMode: 'witness',
      witnessUrl: 'https://w.example.com',
      leaseTtlSeconds: 30,
    };
    const res = await send(app, 'POST', '/disaster-recovery/setup/first', body);

    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), {
      success: true,
      data: {
        pairingCode: 'GSDR1.abc',
        operatorToken: 'token',
        restarting: ['gluesync-core-hub', 'gluesync-chronos'],
        warnings: ['The witness at https://w.example.com does not answer yet.'],
      },
    });
    assert.deepEqual(calls.first, [body]);
    await app.close();
  });

  it('refuses a first-site body that is not shaped right with 400, before the handler', async () => {
    const { app, calls } = await buildApp();
    const bad: ReadonlyArray<unknown> = [
      {},
      { ...FIRST, failoverMode: 'auto' },
      { ...FIRST, thisSite: { nodeId: 'a' } },
      { ...FIRST, leaseTtlSeconds: 'x' },
    ];

    const results = await Promise.all(
      bad.map(body =>
        send(app, 'POST', '/disaster-recovery/setup/first', body),
      ),
    );

    results.forEach(res => {
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().success, false);
    });
    assert.deepEqual(calls.first, []);
    await app.close();
  });

  it('POST /disaster-recovery/setup/join wants the code and the confirmation that the data is moved aside', async () => {
    const { app, calls } = await buildApp({
      join: {
        success: true,
        data: {
          operatorToken: 'token',
          nodeId: 'site-b',
          peerUrl: 'http://10.0.0.1:1717',
          restarting: ['gluesync-core-hub', 'gluesync-chronos'],
        },
      },
    });
    const url = '/disaster-recovery/setup/join';

    assert.equal(
      (await send(app, 'POST', url, { pairingCode: 'GSDR1.x' })).statusCode,
      400,
    );
    assert.equal(
      (
        await send(app, 'POST', url, {
          pairingCode: 'GSDR1.x',
          confirmDataMovedAside: false,
        })
      ).statusCode,
      400,
    );
    assert.deepEqual(calls.join, []);

    const res = await send(app, 'POST', url, {
      pairingCode: 'GSDR1.x',
      confirmDataMovedAside: true,
    });

    assert.equal(res.statusCode, 202);
    assert.equal(res.json().data.nodeId, 'site-b');
    assert.equal(calls.join.length, 1);
    await app.close();
  });

  it('POST /disaster-recovery/disable wants confirm: true', async () => {
    const { app, calls } = await buildApp({
      disable: { success: true, data: { restarting: ['gluesync-core-hub'] } },
    });
    const url = '/disaster-recovery/disable';

    assert.equal((await send(app, 'POST', url, {})).statusCode, 400);
    assert.equal(
      (await send(app, 'POST', url, { confirm: false })).statusCode,
      400,
    );
    assert.deepEqual(calls.disable, []);

    const res = await send(app, 'POST', url, { confirm: true });

    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), {
      success: true,
      data: { restarting: ['gluesync-core-hub'] },
    });
    await app.close();
  });

  it('POST /disaster-recovery/setup/pairing-code takes no body and answers only the code', async () => {
    const { app, calls } = await buildApp({
      pairing: {
        success: true,
        data: { pairingCode: 'GSDR1.abc', sharedSecret: 'must-not-leave' },
      },
    });
    const res = await send(
      app,
      'POST',
      '/disaster-recovery/setup/pairing-code',
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      success: true,
      data: { pairingCode: 'GSDR1.abc' },
    });
    assert.ok(!res.body.includes('must-not-leave'));
    assert.equal(calls.pairing.length, 1);
    // never a GET: the code must not be cacheable or end up in a URL log
    assert.equal(
      (await send(app, 'GET', '/disaster-recovery/setup/pairing-code'))
        .statusCode,
      404,
    );
    await app.close();
  });
});
