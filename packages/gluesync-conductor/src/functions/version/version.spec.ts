import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type Docker from 'dockerode';
import fastify from 'fastify';

import { resetContainerEngineCache } from '../../helpers/containerRuntime/containerEngine';
import handler from './version';

const appWith = (
  call: () => Promise<unknown>,
  info?: () => Promise<unknown>,
) => {
  const app = fastify();
  app.decorate('docker', { version: call, info } as unknown as Docker);
  app.get('/version', handler);
  return app;
};

describe('version handler', () => {
  beforeEach(resetContainerEngineCache);

  it('returns what the Docker daemon reports', async () => {
    const app = appWith(async () => ({ ApiVersion: '1.45' }));
    const res = await app.inject({ method: 'GET', url: '/version' });
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
        ApiVersion: '1.44',
        Components: [{ Name: 'Podman Engine', Version: '5.8.2' }],
      }),
      async () => ({ SecurityOptions: ['name=rootless', 'name=selinux'] }),
    );
    const res = await app.inject({ method: 'GET', url: '/version' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.containerEngine, {
      engine: 'podman',
      rootless: true,
      version: '5.8.2',
    });
    assert.equal(res.json().data.ApiVersion, '1.44');
    await app.close();
  });

  it('reports Docker as the engine of a Docker daemon', async () => {
    const app = appWith(
      async () => ({ Version: '29.0.1', Components: [{ Name: 'Engine' }] }),
      async () => ({ SecurityOptions: ['name=seccomp,profile=builtin'] }),
    );
    const res = await app.inject({ method: 'GET', url: '/version' });
    assert.deepEqual(res.json().data.containerEngine, {
      engine: 'docker',
      rootless: false,
      version: '29.0.1',
    });
    await app.close();
  });

  it('answers 503 and stays up when the daemon is unavailable', async () => {
    const app = appWith(async () => {
      throw new Error('connect ECONNREFUSED /var/run/docker.sock');
    });
    const res = await app.inject({ method: 'GET', url: '/version' });
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
    const res = await app.inject({ method: 'GET', url: '/version' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().details, 'daemon gone');
    await app.close();
  });
});
