import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import fastify, { type FastifyPluginAsync } from 'fastify';
import { parse } from 'yaml';

import fakeKubernetesClient, {
  apiError,
  buildPod,
  buildWorkload,
  chartCluster,
} from '../../../testing/fakeKubernetesClient';
import kubernetesStubs, {
  untouchableDocker,
} from '../../../testing/kubernetesStubs';
import loadWithStubs from '../../../testing/loadWithStubs';
import { KubernetesClient } from '../../../helpers/kubernetes/kubernetes.model';

const agent = buildWorkload('prod-gluesync-mssql-ct', {
  image: 'molo17/gluesync-mssql-ct:2.3.1.4',
  type: 'agent',
  env: [{ name: 'INITIAL_AGENT_ID', value: '7' }],
});

const withAgent = () => {
  const cluster = chartCluster();

  return fakeKubernetesClient({
    ...cluster,
    deployments: [...cluster.deployments, agent],
    pods: [...cluster.pods, buildPod(agent, { name: 'agent-pod' })],
  });
};

// The real routes (and their response schemas) over the real handler
const get = async (url: string, client: KubernetesClient = withAgent()) => {
  const handler = loadWithStubs<{ default: unknown }>(
    path.resolve(__dirname, './getServices'),
    kubernetesStubs(client),
  ).default;
  const routes = loadWithStubs<{ default: FastifyPluginAsync }>(
    path.resolve(__dirname, '../../../routes/services'),
    { [path.resolve(__dirname, './getServices')]: { default: handler } },
  );
  const { docker, uses } = untouchableDocker();
  const app = fastify();
  app.decorate('docker', docker);
  await app.register(routes.default);
  await app.ready();

  const res = await app.inject({ method: 'GET', url });
  await app.close();

  assert.deepEqual(uses, []);

  return res;
};

describe('GET /services in kubernetes mode', () => {
  it('lists the agents, as compose mode does', async () => {
    const res = await get('/services');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.json().data), ['gluesync-mssql-ct']);
    assert.equal(
      res.json().data['gluesync-mssql-ct'].image,
      'molo17/gluesync-mssql-ct:2.3.1.4',
    );
    assert.deepEqual(res.json().data['gluesync-mssql-ct'].environment, {
      INITIAL_AGENT_ID: '7',
    });
  });

  it('lists agents and modules when raw, as compose mode does', async () => {
    const res = await get('/services?raw=true');

    assert.deepEqual(Object.keys(res.json().data), [
      'gluesync-chronos',
      'gluesync-mssql-ct',
    ]);
    assert.ok(
      res
        .json()
        .data[
          'gluesync-chronos'
        ].labels.includes('com.molo17.conductor.type=module'),
    );
  });

  it('answers one service by its Docker id', async () => {
    const res = await get('/services/gluesync-core-hub');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.json().data), ['gluesync-core-hub']);
    assert.equal(
      res.json().data['gluesync-core-hub'].image,
      'molo17/gluesync-core-hub:2.3.1.4',
    );
    assert.equal(
      res.json().data['gluesync-core-hub'].labels['com.molo17.conductor.type'],
      'core-hub',
    );
  });

  it('answers it as YAML with format=string', async () => {
    const res = await get('/services/grafana?format=string');

    assert.equal(
      parse(res.json().data).grafana.image,
      'molo17/grafana:13.0.11.dashboard3',
    );
  });

  it('answers 404 for an id that is not in the namespace, the cluster name included', async () => {
    const byClusterName = await get('/services/prod-gluesync-core-hub');

    assert.equal(byClusterName.statusCode, 404);
    assert.deepEqual(byClusterName.json(), {
      success: false,
      error: 'Service prod-gluesync-core-hub not found in namespace gluesync',
    });
  });

  it('answers 503 when the Kubernetes API refuses the list', async () => {
    const forbidden = '/apis/apps/v1/namespaces/gluesync/deployments';
    const res = await get(
      '/services',
      fakeKubernetesClient({
        paths: { [forbidden]: apiError(403, forbidden) },
      }),
    );

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'Kubernetes API unavailable');
    assert.match(res.json().details, /answered 403/);
  });
});
