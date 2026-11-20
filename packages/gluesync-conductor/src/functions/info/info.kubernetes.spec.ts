import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import fastify, { type RouteHandlerMethod } from 'fastify';

import fakeKubernetesClient from '../../testing/fakeKubernetesClient';
import kubernetesStubs, {
  untouchableDocker,
} from '../../testing/kubernetesStubs';
import loadWithStubs from '../../testing/loadWithStubs';
import { resetKubernetesNodeCache } from '../../helpers/kubernetes/getKubernetesSystemInfo/getKubernetesSystemInfo';
import { KubernetesClient } from '../../helpers/kubernetes/kubernetes.model';

const version = {
  gitVersion: 'v1.34.0',
  gitCommit: 'abc123',
  goVersion: 'go1.24.6',
  buildDate: '2026-08-27T00:00:00Z',
  platform: 'linux/arm64',
};

const get = async (name: 'info' | 'version', client: KubernetesClient) => {
  const directory =
    name === 'info' ? __dirname : path.resolve(__dirname, '../version');
  const handler = loadWithStubs<{ default: RouteHandlerMethod }>(
    path.resolve(directory, `./${name}`),
    kubernetesStubs(client),
  ).default;
  const { docker, uses } = untouchableDocker();
  const app = fastify();
  app.decorate('docker', docker);
  app.get(`/${name}`, handler);

  const res = await app.inject({ method: 'GET', url: `/${name}` });
  await app.close();

  assert.deepEqual(uses, []);

  return res;
};

beforeEach(() => {
  resetKubernetesNodeCache();
});

describe('GET /info and /version in kubernetes mode', () => {
  it('reports the orchestrator and the cluster instead of the Docker daemon', async () => {
    const res = await get(
      'info',
      fakeKubernetesClient({
        namespace: 'kit',
        paths: { '/version': version },
      }),
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      success: true,
      data: {
        orchestrator: 'kubernetes',
        namespace: 'kit',
        ServerVersion: 'v1.34.0',
      },
    });
  });

  it('reports the version of the API server under the keys of Docker', async () => {
    const res = await get(
      'version',
      fakeKubernetesClient({ paths: { '/version': version } }),
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, {
      orchestrator: 'kubernetes',
      Platform: { Name: 'Kubernetes' },
      Version: 'v1.34.0',
      GitCommit: 'abc123',
      GoVersion: 'go1.24.6',
      Os: 'linux',
      Arch: 'arm64',
      BuildTime: '2026-08-27T00:00:00Z',
    });
  });

  it('answers 503 and stays up when the API server does not answer', async () => {
    const responses = await Promise.all([
      get('info', fakeKubernetesClient()),
      get('version', fakeKubernetesClient()),
    ]);

    responses.forEach(res => {
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().success, false);
      assert.equal(res.json().error, 'Kubernetes API unavailable');
      assert.match(res.json().details, /404/);
    });
  });
});
