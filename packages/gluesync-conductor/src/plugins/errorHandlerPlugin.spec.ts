import assert from 'node:assert/strict';
import { STATUS_CODES } from 'node:http';
import { Writable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import fastify, { FastifyInstance } from 'fastify';

import errorHandlerPlugin from './errorHandlerPlugin';

type LogLine = Readonly<{ level: number; msg: string }>;

const PINO_INFO = 30;
const PINO_ERROR = 50;

const SPECIAL = 'SpecialError';

const apps: FastifyInstance[] = [];

type Routes = (app: FastifyInstance) => void;

const registerRoutes: Routes = app => {
  app.post(
    '/validated',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
    },
    async () => ({ ok: true }),
  );
  app.post('/echo', async request => request.body);
  app.get('/boom', async () => {
    throw new Error('disk exploded');
  });
  app.get('/conflict', async () => {
    throw Object.assign(new Error('already there'), { statusCode: 409 });
  });
  app.get('/special', async () => {
    throw Object.assign(new Error('special failure'), { name: SPECIAL });
  });
  app.get('/bad-json-message', async () => {
    throw Object.assign(new Error('Body is not valid JSON'), {
      statusCode: 400,
    });
  });
  app.get('/odd-status', async () => {
    throw Object.assign(new Error('weird'), { statusCode: 299 });
  });
  app.get('/no-phrase', async () => {
    throw Object.assign(new Error('custom status'), { statusCode: 599 });
  });
  app.get('/bad-gateway', async () => {
    throw Object.assign(new Error('upstream down'), { statusCode: 502 });
  });
};

// `mount` decides where the routes live; like in index.ts, error handlers are
// registered before the routes they apply to.
const build = async (
  mount: (app: FastifyInstance, routes: Routes) => void = (app, routes) =>
    routes(app),
) => {
  const lines: LogLine[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)));
      callback();
    },
  });
  const app = fastify({ logger: { level: 'info', stream } });
  apps.push(app);

  await app.register(errorHandlerPlugin);
  mount(app, registerRoutes);
  await app.ready();

  return { app, lines };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
});

describe('errorHandlerPlugin', () => {
  it('answers a failed validation with 400 and the ErrorResponse shape', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/validated',
      payload: {},
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Bad Request',
      details: "body must have required property 'name'",
    });
  });

  it('answers an invalid JSON body with 400 and a fixed message', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Bad Request',
      details: 'Invalid JSON body',
    });
  });

  it('hides the parser message of any "Body is not valid JSON" error', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/bad-json-message' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().details, 'Invalid JSON body');
  });

  it('answers an unknown route with the ErrorResponse shape', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/nope' });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Not Found',
      details: 'Route not found',
    });
  });

  it('answers an uncaught throw with 500 "Internal Server Error" and logs it at error level', async () => {
    const { app, lines } = await build();
    const res = await app.inject({ method: 'GET', url: '/boom' });

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Internal Server Error',
      details: 'disk exploded',
    });
    assert.ok(
      lines.some(
        line => line.level === PINO_ERROR && line.msg === 'disk exploded',
      ),
      'the 500 is logged at error level',
    );
  });

  it('names a 4xx after its HTTP reason phrase and logs it at info level only', async () => {
    const { app, lines } = await build();
    const res = await app.inject({ method: 'GET', url: '/conflict' });

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Conflict',
      details: 'already there',
    });
    assert.ok(
      lines.some(
        line => line.level === PINO_INFO && line.msg === 'already there',
      ),
    );
    assert.equal(
      lines.filter(line => line.level >= PINO_ERROR).length,
      0,
      'a 4xx is not an error-level log',
    );
  });

  it('names Fastify own 413 after its reason phrase', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ big: 'x'.repeat(1_100_000) }),
    });

    assert.equal(res.statusCode, 413);
    assert.equal(res.json().error, STATUS_CODES[413]);
    assert.equal(res.json().success, false);
  });

  it('keeps the upstream 5xx status and names it', async () => {
    const { app, lines } = await build();
    const res = await app.inject({ method: 'GET', url: '/bad-gateway' });

    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, 'Bad Gateway');
    assert.ok(lines.some(line => line.level === PINO_ERROR));
  });

  it('falls back to a generic title for a status without a reason phrase', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/no-phrase' });

    assert.equal(res.statusCode, 599);
    assert.equal(res.json().error, 'Error');
  });

  it('turns a statusCode outside 4xx/5xx into a 500', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/odd-status' });

    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, 'Internal Server Error');
  });
});

// Conductor's localErrorHandler plugin (MR !130) is registered after this one.
// It answers DiskFullError / ComposeFileCorruptError itself and re-sends every
// other error with `reply.send(error)`, which makes Fastify hand it to the
// handler registered before it: this plugin. Its real code is not on develop,
// so a stand-in with the same behaviour pins the contract it relies on.
describe('errorHandlerPlugin as the fallback of a later error handler (contract of localErrorHandler)', () => {
  // Registered in its own scope only to keep Fastify from warning about a
  // second setErrorHandler in the root scope; the chaining is the same.
  const buildChain = () =>
    build((app, routes) => {
      app.register((scope, _options, done) => {
        scope.setErrorHandler((error: Error, _request, reply) => {
          if (error.name === SPECIAL) {
            reply.status(507).send({ handledBy: 'local', code: 'SPECIAL' });
            return;
          }
          reply.send(error);
        });
        routes(scope);
        done();
      });
    });

  it('lets the later handler answer the error it knows', async () => {
    const { app } = await buildChain();
    const res = await app.inject({ method: 'GET', url: '/special' });

    assert.equal(res.statusCode, 507);
    assert.deepEqual(res.json(), { handledBy: 'local', code: 'SPECIAL' });
  });

  it('falls back to the unified 500 for any other error', async () => {
    const { app, lines } = await buildChain();
    const res = await app.inject({ method: 'GET', url: '/boom' });

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Internal Server Error',
      details: 'disk exploded',
    });
    assert.ok(lines.some(line => line.level === PINO_ERROR));
  });

  it('falls back to the unified 400 for a validation error', async () => {
    const { app } = await buildChain();
    const res = await app.inject({
      method: 'POST',
      url: '/validated',
      payload: {},
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Bad Request',
      details: "body must have required property 'name'",
    });
  });
});
