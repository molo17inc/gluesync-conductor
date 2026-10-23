import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Docker from 'dockerode';
import fastify from 'fastify';

import handler from './info';

const appWith = (call: () => Promise<unknown>) => {
  const app = fastify();
  app.decorate('docker', { info: call } as unknown as Docker);
  app.get('/info', handler);
  return app;
};

describe('info handler', () => {
  it('returns what the Docker daemon reports', async () => {
    const app = appWith(async () => ({ ApiVersion: '1.45' }));
    const res = await app.inject({ method: 'GET', url: '/info' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      success: true,
      data: { ApiVersion: '1.45' },
    });
    await app.close();
  });

  it('answers 503 and stays up when the daemon is unavailable', async () => {
    const app = appWith(async () => {
      throw new Error('connect ECONNREFUSED /var/run/docker.sock');
    });
    const res = await app.inject({ method: 'GET', url: '/info' });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), {
      success: false,
      error: 'Docker daemon unavailable',
      details: 'connect ECONNREFUSED /var/run/docker.sock',
    });
    await app.close();
  });

  it('reports a thrown value that is not an Error as text', async () => {
    const app = appWith(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'daemon gone';
    });
    const res = await app.inject({ method: 'GET', url: '/info' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().details, 'daemon gone');
    await app.close();
  });
});
