import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fastify from 'fastify';

import { ComposeFileCorruptError } from '../helpers/composeFile/ensureValidCompose/composeFile.errors';
import { DiskFullError } from '../helpers/file/safeWriteFile/safeWriteFile.errors';
import localErrorHandlerPlugin from './localErrorHandler';

const buildApp = async (failure: unknown) => {
  const app = fastify();
  await app.register(localErrorHandlerPlugin);
  app.get('/boom', async () => {
    throw failure;
  });
  app.post(
    '/checked',
    { schema: { body: { type: 'object', required: ['a'] } } },
    async () => ({ success: true }),
  );
  await app.ready();
  return app;
};

describe('local error handler', () => {
  it('answers a full disk thrown out of a route with 507 and its diagnosis', async () => {
    const app = await buildApp(new DiskFullError('/srv/dc.yml', 100, 5));
    const res = await app.inject({ method: 'GET', url: '/boom' });

    assert.equal(res.statusCode, 507);
    assert.equal(res.json().success, false);
    assert.equal(res.json().diagnosis.code, 'DISK_FULL');
    assert.match(res.json().details, /not enough free disk space/);
  });

  it('answers a corrupt compose file with 500 and its diagnosis', async () => {
    const app = await buildApp(new ComposeFileCorruptError('/srv/dc.yml', 'x'));
    const res = await app.inject({ method: 'GET', url: '/boom' });

    assert.equal(res.statusCode, 500);
    assert.equal(res.json().diagnosis.code, 'COMPOSE_FILE_CORRUPT');
  });

  it('leaves other errors to the default handler', async () => {
    const app = await buildApp(new Error('boom'));
    const res = await app.inject({ method: 'GET', url: '/boom' });

    assert.equal(res.statusCode, 500);
    assert.equal(res.json().message, 'boom');
    assert.equal(res.json().diagnosis, undefined);
  });

  it('keeps the 400 of a request that fails validation', async () => {
    const app = await buildApp(new Error('unused'));
    const res = await app.inject({
      method: 'POST',
      url: '/checked',
      payload: {},
    });

    assert.equal(res.statusCode, 400);
  });
});
