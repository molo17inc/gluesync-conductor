import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type Docker from 'dockerode';
import fastify from 'fastify';

import { resetContainerEngineCache } from '../../helpers/containerRuntime/containerEngine';
import handler from './info';

const appWith = (
  call: () => Promise<unknown>,
  version?: () => Promise<unknown>,
) => {
  const app = fastify();
  app.decorate('docker', { info: call, version } as unknown as Docker);
  app.get('/info', handler);
  return app;
};

describe('info handler', () => {
  beforeEach(resetContainerEngineCache);

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

  it('adds which engine it is, and whether it is rootless', async () => {
    const app = appWith(
      async () => ({
        ServerVersion: '5.8.2',
        SecurityOptions: ['name=rootless'],
      }),
      async () => ({
        Components: [{ Name: 'Podman Engine', Version: '5.8.2' }],
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/info' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.containerEngine, {
      engine: 'podman',
      rootless: true,
      version: '5.8.2',
    });
    assert.equal(res.json().data.ServerVersion, '5.8.2');
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
