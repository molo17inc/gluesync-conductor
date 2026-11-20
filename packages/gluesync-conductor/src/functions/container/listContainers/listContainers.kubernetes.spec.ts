import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import fastify, {
  type FastifyPluginAsync,
  type RouteHandlerMethod,
} from 'fastify';

import fakeKubernetesClient, {
  apiError,
  buildWorkload,
  chartCluster,
} from '../../../testing/fakeKubernetesClient';
import kubernetesStubs, {
  untouchableDocker,
} from '../../../testing/kubernetesStubs';
import loadWithStubs from '../../../testing/loadWithStubs';
import { resetKubernetesNodeCache } from '../../../helpers/kubernetes/getKubernetesSystemInfo/getKubernetesSystemInfo';
import { KubernetesClient } from '../../../helpers/kubernetes/kubernetes.model';

type Subject = Readonly<{ default: FastifyPluginAsync }>;

const NODE_PATHS = {
  '/api/v1/namespaces/gluesync/pods/conductor-0': {
    metadata: { name: 'conductor-0' },
    spec: { nodeName: 'node-a' },
  },
  '/api/v1/nodes/node-a': {
    metadata: { name: 'node-a' },
    status: { capacity: { cpu: '8', memory: '16Gi' } },
  },
};

// Real route (so the response schema is in play) over the real handler and the
// real Kubernetes helpers, reading a fake cluster
const buildApp = async (client: KubernetesClient, role = 'admin') => {
  const handler = loadWithStubs<{ default: RouteHandlerMethod }>(
    path.resolve(__dirname, './listContainers'),
    {
      ...kubernetesStubs(client),
      [path.resolve(__dirname, '../../../security')]: {
        canModifyConfiguration: (value: string) => value === 'admin',
      },
    },
  ).default;

  const route = loadWithStubs<Subject>(
    path.resolve(__dirname, '../../../routes/containers'),
    {
      [path.resolve(__dirname, './listContainers')]: { default: handler },
      [path.resolve(__dirname, '../doContainersAction/doContainersAction')]: {
        default: async () => ({ success: true }),
      },
      [path.resolve(__dirname, '../../../security')]: {
        requireContainerAction: () => async () => undefined,
      },
    },
  );

  const { docker, uses } = untouchableDocker();
  const app = fastify();
  app.decorate('docker', docker);
  app.addHook('onRequest', async req => {
    Object.assign(req, { currentUser: { role } });
  });
  await app.register(route.default);
  await app.ready();

  return { app, uses };
};

beforeEach(() => {
  resetKubernetesNodeCache();
});

describe('GET /containers in kubernetes mode', () => {
  it('lists the workloads of the namespace in the shape of compose mode, without Docker', async () => {
    const { app, uses } = await buildApp(
      fakeKubernetesClient({ ...chartCluster(), paths: NODE_PATHS }),
    );

    const res = await app.inject({ method: 'GET', url: '/containers' });
    const { data } = res.json();

    assert.equal(res.statusCode, 200);
    assert.deepEqual(data.systemInfo, { ncpu: 8, memTotal: 16 * 1024 ** 3 });
    assert.deepEqual(
      data.containers.map((c: any) => [
        c.id,
        c.type,
        c.persisted,
        c.info.state,
      ]),
      [
        ['gluesync-chronos', 'module', true, 'running'],
        ['gluesync-core-hub', 'core-hub', true, 'running'],
        ['grafana', 'third-party', true, 'running'],
        ['prometheus', 'third-party', true, 'running'],
      ],
    );

    const coreHub = data.containers[1];

    assert.equal(coreHub.service.image, 'molo17/gluesync-core-hub:2.3.1.4');
    assert.equal(coreHub.info.image, 'molo17/gluesync-core-hub:2.3.1.4');
    assert.equal(coreHub.info.parsedImage.tag, '2.3.1.4');
    assert.equal(coreHub.info.name, 'prod-gluesync-core-hub-0');
    assert.deepEqual(coreHub.info.kubernetes, {
      kind: 'StatefulSet',
      name: 'prod-gluesync-core-hub',
      namespace: 'gluesync',
      release: 'prod',
      pod: 'prod-gluesync-core-hub-0',
      node: 'node-a',
      replicas: 1,
      desiredReplicas: 1,
      updatedReplicas: 1,
      restarts: 0,
    });
    assert.deepEqual(uses, []);
    await app.close();
  });

  it('filters by type like compose mode', async () => {
    const stray = buildWorkload('stray', {
      release: '',
      image: 'busybox:1.36',
    });
    const cluster = chartCluster();
    const { app } = await buildApp(
      fakeKubernetesClient({
        ...cluster,
        deployments: [...cluster.deployments, stray],
      }),
    );

    const ids = async (type: string) =>
      (await app.inject({ method: 'GET', url: `/containers?type=${type}` }))
        .json()
        .data.containers.map((c: any) => c.id);

    assert.deepEqual(await ids('core-hub'), ['gluesync-core-hub']);
    assert.deepEqual(await ids('module'), ['gluesync-chronos']);
    assert.deepEqual(await ids('third-party'), ['grafana', 'prometheus']);
    assert.deepEqual(await ids('agent'), []);
    assert.deepEqual(await ids('unknown'), ['stray']);
    assert.equal((await ids('all')).length, 5);
    await app.close();
  });

  it('omits systemInfo values cleanly when the node cannot be read', async () => {
    const { app } = await buildApp(fakeKubernetesClient(chartCluster()));

    const res = await app.inject({ method: 'GET', url: '/containers' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.systemInfo, {});
    await app.close();
  });

  it('redacts sensitive environment values for a role that cannot change the configuration', async () => {
    const client = fakeKubernetesClient(chartCluster());
    const admin = await buildApp(client, 'admin');
    const viewer = await buildApp(client, 'viewer');

    const environment = async ({ app }: typeof admin) =>
      (
        await app.inject({ method: 'GET', url: '/containers?type=core-hub' })
      ).json().data.containers[0].service.environment;

    assert.deepEqual(await environment(admin), {
      SSL_ENABLED: 'true',
      ADMIN_PASSWORD: 'literal-secret',
    });
    assert.deepEqual(await environment(viewer), {
      SSL_ENABLED: 'true',
      ADMIN_PASSWORD: '***REDACTED***',
    });
    await admin.app.close();
    await viewer.app.close();
  });

  it('answers an empty list for a namespace with no workload', async () => {
    const { app } = await buildApp(fakeKubernetesClient());

    const res = await app.inject({
      method: 'GET',
      url: '/containers?type=all',
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.containers, []);
    await app.close();
  });

  it('answers 503 with the reason when the Kubernetes API refuses the list', async () => {
    const path403 = '/apis/apps/v1/namespaces/gluesync/statefulsets';
    const { app } = await buildApp(
      fakeKubernetesClient({ paths: { [path403]: apiError(403, path403) } }),
    );

    const res = await app.inject({ method: 'GET', url: '/containers' });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().success, false);
    assert.equal(res.json().error, 'Kubernetes API unavailable');
    assert.match(res.json().details, /answered 403/);
    await app.close();
  });
});
