import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type RouteHandlerMethod,
} from 'fastify';

import loadWithStubs from '../testing/loadWithStubs';

type Subject = Readonly<{ default: FastifyPluginAsync }>;

const buildApp = async (action: RouteHandlerMethod) => {
  const seen: unknown[] = [];
  const subject = loadWithStubs<Subject>(
    path.resolve(__dirname, './containers'),
    {
      [path.resolve(
        __dirname,
        '../functions/container/listContainers/listContainers',
      )]: {
        default: async () => ({ success: true, data: { containers: [] } }),
      },
      [path.resolve(
        __dirname,
        '../functions/container/doContainersAction/doContainersAction',
      )]: {
        default: (async (req, reply) => {
          seen.push(req.body);
          return action.call(req.server, req, reply);
        }) satisfies RouteHandlerMethod,
      },
      [path.resolve(__dirname, '../security')]: {
        // The real guard answers 403 for a role that may not run the action.
        requireContainerAction: () => async (req: any, reply: any) => {
          if (req.headers['x-role'] === 'viewer') {
            reply.code(403).send({ success: false, error: 'Forbidden' });
          }
        },
      },
    },
  );
  const app = fastify();
  await app.register(subject.default);
  await app.ready();
  return { app, seen };
};

const post = (app: FastifyInstance, payload: unknown, role = 'manager') =>
  app.inject({
    method: 'POST',
    url: '/containers',
    headers: { 'x-role': role },
    payload: payload as Record<string, unknown>,
  });

describe('POST /containers', () => {
  it('normalizes the release channel before the action runs', async () => {
    const { app, seen } = await buildApp(async () => ({
      success: true,
      data: { containers: [{ id: 'grafana', status: 'OK' }] },
    }));
    const res = await post(app, {
      action: 'update',
      ids: ['grafana'],
      releaseChannel: 'GA',
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, [
      { action: 'update', ids: ['grafana'], releaseChannel: 'ga' },
    ]);
    assert.equal(res.json().data.containers[0].id, 'grafana');
    await app.close();
  });

  it('refuses an unknown release channel with 500 before running anything', async () => {
    const { app, seen } = await buildApp(async () => ({ success: true }));
    const res = await post(app, {
      action: 'update',
      ids: ['grafana'],
      releaseChannel: 'nightly',
    });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Invalid releaseChannel',
      details: 'Allowed values: alpha, beta, ga',
    });
    assert.equal(seen.length, 0);
    await app.close();
  });

  it('runs the action without a release channel', async () => {
    const { app, seen } = await buildApp(async () => ({ success: true }));
    const res = await post(app, { action: 'restart', ids: [] });
    assert.equal(res.statusCode, 200);
    assert.equal(
      (seen[0] as { releaseChannel?: string }).releaseChannel,
      undefined,
    );
    await app.close();
  });

  it('keeps out a role the container-action guard refuses', async () => {
    const { app, seen } = await buildApp(async () => ({ success: true }));
    const res = await post(app, { action: 'update', ids: ['a'] }, 'viewer');
    assert.equal(res.statusCode, 403);
    assert.equal(seen.length, 0);
    await app.close();
  });

  it('serializes the 409 reply of a different running action', async () => {
    const { app } = await buildApp(async (_req, reply) =>
      reply.code(409).header('Retry-After', '5').send({
        success: false,
        error: 'Another container action is running',
        details: 'update since 2026-10-23T10:00:00Z',
        internal: 'must not leak',
      }),
    );
    const res = await post(app, { action: 'update', ids: ['a'] });
    assert.equal(res.statusCode, 409);
    assert.equal(res.headers['retry-after'], '5');
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Another container action is running',
      details: 'update since 2026-10-23T10:00:00Z',
    });
    await app.close();
  });

  it('serializes the 503 reply while the conductor updates itself', async () => {
    const diagnosis = {
      schemaVersion: 1,
      code: 'CONDUCTOR_UPDATING',
      owner: 'local',
      resolutionCodes: ['WAIT_FOR_CONDUCTOR_UPDATE'],
    };
    const { app } = await buildApp(async (_req, reply) =>
      reply.code(503).send({
        success: false,
        error: 'Conductor is updating',
        details: 'only restart is accepted',
        diagnosis,
      }),
    );
    const res = await post(app, { action: 'update', ids: ['a'] });
    assert.equal(res.statusCode, 503);
    // The schema must not strip the diagnosis: the UI relies on it to wait.
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Conductor is updating',
      details: 'only restart is accepted',
      diagnosis,
    });
    await app.close();
  });
});

describe('GET /containers', () => {
  it('is registered next to the POST route', async () => {
    const { app } = await buildApp(async () => ({ success: true }));
    const res = await app.inject({ method: 'GET', url: '/containers' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { success: true, data: { containers: [] } });
    await app.close();
  });
});
