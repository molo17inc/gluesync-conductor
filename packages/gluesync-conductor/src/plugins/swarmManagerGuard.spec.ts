import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import fastify, { type FastifyPluginAsync } from 'fastify';

import loadWithStubs from '../testing/loadWithStubs';

type Subject = Readonly<{ default: FastifyPluginAsync }>;

const build = async (orchestrator: unknown) => {
  const subject = loadWithStubs<Subject>(
    path.resolve(__dirname, './swarmManagerGuard'),
    {
      [path.resolve(
        __dirname,
        '../helpers/orchestrator/getOrchestrator/getOrchestrator',
      )]: { default: async () => orchestrator },
    },
  );
  const app = fastify();
  app.decorate('docker', {} as any);
  await app.register(subject.default);
  [
    '/health',
    '/docs',
    '/docs/static/x.css',
    '/openapi.json',
    '/containers',
    '/services',
    '/healthz',
  ].forEach(url => app.get(url, async () => ({ ok: true })));
  await app.ready();

  return app;
};

const swarm = (isManager: boolean) => ({
  mode: 'swarm',
  namespace: 'gs',
  selfService: 'gluesync-conductor',
  isManager,
});

describe('swarmManagerGuard', () => {
  it('answers 503 SWARM_NOT_MANAGER on a worker', async () => {
    const app = await build(swarm(false));

    const response = await app.inject({ method: 'GET', url: '/containers' });
    const body = response.json();

    assert.equal(response.statusCode, 503);
    assert.equal(body.success, false);
    assert.equal(typeof body.error, 'string');
    assert.equal(typeof body.message, 'string');
    assert.equal(body.diagnosis.code, 'SWARM_NOT_MANAGER');
    assert.equal(body.diagnosis.owner, 'local');
    assert.deepEqual(body.diagnosis.resolutionCodes, [
      'RUN_CONDUCTOR_ON_SWARM_MANAGER',
    ]);
    await app.close();
  });

  it('blocks every method and path, query strings included', async () => {
    const app = await build(swarm(false));

    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/containers' }),
      app.inject({ method: 'GET', url: '/services?x=1' }),
      app.inject({ method: 'GET', url: '/does-not-exist' }),
    ]);

    assert.deepEqual(
      responses.map(r => r.statusCode),
      [503, 503, 503],
    );
    await app.close();
  });

  it('keeps health, docs and the openapi document available on a worker', async () => {
    const app = await build(swarm(false));

    const responses = await Promise.all(
      [
        '/health',
        '/health?probe=1',
        '/docs',
        '/docs/static/x.css',
        '/openapi.json',
      ].map(url => app.inject({ method: 'GET', url })),
    );

    assert.deepEqual(
      responses.map(r => r.statusCode),
      [200, 200, 200, 200, 200],
    );
    await app.close();
  });

  it('lets everything through on a manager', async () => {
    const app = await build(swarm(true));

    assert.equal(
      (await app.inject({ method: 'GET', url: '/containers' })).statusCode,
      200,
    );
    await app.close();
  });

  it('lets everything through in compose mode', async () => {
    const app = await build({ mode: 'compose' });

    assert.equal(
      (await app.inject({ method: 'GET', url: '/containers' })).statusCode,
      200,
    );
    await app.close();
  });

  it('does not match paths that only start like an allowed one', async () => {
    const app = await build(swarm(false));

    assert.equal(
      (await app.inject({ method: 'GET', url: '/healthz' })).statusCode,
      503,
    );
    await app.close();
  });
});
