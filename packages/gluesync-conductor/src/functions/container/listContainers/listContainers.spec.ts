/* eslint-disable no-template-curly-in-string -- the `${VAR}` strings are the interpolations the stack file keeps as written */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import fastify, {
  type FastifyPluginAsync,
  type RouteHandlerMethod,
} from 'fastify';
import type Docker from 'dockerode';

import fakeSwarmDocker, {
  buildService,
  buildTask,
} from '../../../testing/fakeSwarmDocker';
import { labStack, labStackWithoutTypes } from '../../../testing/labStack';
import loadWithStubs from '../../../testing/loadWithStubs';
import parseComposeFile from '../../../helpers/composeFile/parseComposeFile/parseComposeFile';
import { Orchestrator } from '../../../helpers/orchestrator/getOrchestrator/getOrchestrator.model';

const helpers = path.resolve(__dirname, '../../../helpers');

const SWARM: Orchestrator = {
  mode: 'swarm',
  namespace: 'gs',
  selfService: 'gluesync-conductor',
  isManager: true,
};

type Subject = Readonly<{ default: FastifyPluginAsync }>;

// Real route (so the response schema is in play) over the real handler, with
// the stack file, the daemon wait and the orchestrator stubbed.
const buildApp = async (
  docker: Docker,
  orchestrator: Orchestrator,
  role = 'admin',
  stack: typeof labStack = labStack,
) => {
  const handler = loadWithStubs<{ default: RouteHandlerMethod }>(
    path.resolve(__dirname, './listContainers'),
    {
      [`${helpers}/composeFile/readComposeFile/readComposeFile`]: {
        readComposeFile: async () => parseComposeFile(stack),
      },
      [`${helpers}/dockerode/getSystemInfo/getSystemInfo`]: {
        default: async () => ({ ncpu: 4, memTotal: 1024 }),
      },
      [`${helpers}/dockerode/waitForDockerDaemon/waitForDockerDaemon`]: {
        default: async () => undefined,
      },
      [`${helpers}/orchestrator/getOrchestrator/getOrchestrator`]: {
        default: async () => orchestrator,
      },
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

  const app = fastify();
  app.decorate('docker', docker);
  app.addHook('onRequest', async req => {
    Object.assign(req, { currentUser: { role } });
  });
  await app.register(route.default);
  await app.ready();

  return app;
};

type Item = Readonly<Record<string, any>>;

const get = async (app: Awaited<ReturnType<typeof buildApp>>, url: string) => {
  const res = await app.inject({ method: 'GET', url });

  assert.equal(res.statusCode, 200);

  return res.json().data as {
    containers: ReadonlyArray<Item>;
    systemInfo: Item;
  };
};

const swarmDocker = () =>
  fakeSwarmDocker({
    nodes: [{ ID: 'node-1', Description: { Hostname: 'manager-1' } }],
    services: [
      buildService('gluesync-core-hub', {
        image: 'molo17/gluesync-core-hub:2.3.0@sha256:abc',
        containerLabels: { 'com.molo17.conductor.service_id': 'hub-uid' },
      }),
      buildService('grafana', {
        image: 'molo17/grafana:13.0.2.dashboard3',
        replicas: 2,
        state: 'updating',
      }),
      buildService('stray'),
    ],
    tasks: [
      buildTask('gluesync-core-hub', {
        containerId: 'hub-container',
        image: 'molo17/gluesync-core-hub:2.3.0@sha256:abc',
      }),
      buildTask('grafana', {
        taskId: 'g1',
        containerId: 'g1-container',
        image: 'molo17/grafana:13.0.2.dashboard3',
      }),
      buildTask('grafana', {
        taskId: 'g2',
        state: 'starting',
        containerId: 'g2-container',
        image: 'molo17/grafana:13.0.2.dashboard3',
      }),
      buildTask('stray'),
    ],
  }).docker;

describe('GET /containers in swarm mode', () => {
  it('answers one entry per stack file service and per swarm service', async () => {
    const app = await buildApp(swarmDocker(), SWARM);

    const { containers, systemInfo } = await get(app, '/containers');

    assert.deepEqual(
      containers.map(({ id, persisted }) => [id, persisted]),
      [
        ['reverse-proxy', true],
        ['gluesync-core-hub', true],
        ['gluesync-chronos', true],
        ['prometheus', true],
        ['grafana', true],
        ['gluesync-conductor', true],
        ['stray', false],
      ],
    );
    assert.deepEqual(systemInfo, { ncpu: 4, memTotal: 1024 });
    await app.close();
  });

  it('serializes info with the swarm details and the Docker-like fields', async () => {
    const app = await buildApp(swarmDocker(), SWARM);

    const { containers } = await get(app, '/containers');
    const hub = containers.find(({ id }) => id === 'gluesync-core-hub');
    const grafana = containers.find(({ id }) => id === 'grafana');

    assert.equal(hub?.type, 'core-hub');
    assert.equal(hub?.info.id, 'hub-container');
    assert.equal(hub?.info.image, 'molo17/gluesync-core-hub:2.3.0');
    assert.equal(hub?.info.state, 'running');
    assert.equal(hub?.info.tag, '2.3.0');
    assert.equal(hub?.info.parsedImage.tag, '2.3.0');
    assert.equal(hub?.info.uniqueId, 'hub-uid');
    assert.deepEqual(hub?.info.swarm, {
      serviceId: 'gluesync-core-hub-sid',
      node: 'manager-1',
      replicas: 1,
      desiredReplicas: 1,
    });
    assert.deepEqual(grafana?.info.swarm, {
      serviceId: 'grafana-sid',
      node: 'manager-1',
      replicas: 1,
      desiredReplicas: 2,
      updateState: 'updating',
    });
    await app.close();
  });

  it('has no info for a stack file service that is not in the swarm', async () => {
    const app = await buildApp(swarmDocker(), SWARM);

    const { containers } = await get(app, '/containers');
    const proxy = containers.find(({ id }) => id === 'reverse-proxy');

    assert.equal(proxy?.info, undefined);
    assert.equal(proxy?.persisted, true);
    await app.close();
  });

  it('keeps the deploy block of the stack file in the service', async () => {
    const app = await buildApp(swarmDocker(), SWARM);

    const { containers } = await get(app, '/containers');
    const hub = containers.find(({ id }) => id === 'gluesync-core-hub');

    assert.deepEqual(hub?.service.deploy.placement, {
      constraints: ['node.labels.gluesync.data == true'],
    });
    assert.equal(hub?.service.deploy.replicas, 1);
    assert.equal(hub?.service.deploy.update_config.failure_action, 'rollback');
    assert.equal(hub?.service.deploy.resources.limits.memory, '8G');
    assert.equal(hub?.service.deploy.labels.length, 3);
    await app.close();
  });

  it('filters by type like compose mode', async () => {
    const app = await buildApp(swarmDocker(), SWARM);

    const modules = await get(app, '/containers?type=module');
    const unknown = await get(app, '/containers?type=unknown');
    const all = await get(app, '/containers?type=all');

    assert.deepEqual(
      modules.containers.map(({ id }) => id),
      ['gluesync-chronos', 'gluesync-conductor'],
    );
    assert.deepEqual(
      unknown.containers.map(({ id }) => id),
      ['stray'],
    );
    assert.equal(all.containers.length, 7);
    await app.close();
  });

  it('types the services of a stack file with no type label, which it never writes', async () => {
    const app = await buildApp(
      swarmDocker(),
      SWARM,
      'admin',
      labStackWithoutTypes,
    );

    const { containers } = await get(app, '/containers');
    const modules = await get(app, '/containers?type=module');
    const unknown = await get(app, '/containers?type=unknown');

    assert.deepEqual(
      containers.map(({ id, type }) => [id, type]),
      [
        ['reverse-proxy', 'third-party'],
        ['gluesync-core-hub', 'core-hub'],
        ['gluesync-chronos', 'module'],
        ['prometheus', 'third-party'],
        ['grafana', 'third-party'],
        ['gluesync-conductor', 'module'],
        ['stray', 'unknown'],
      ],
    );
    assert.deepEqual(
      modules.containers.map(({ id }) => id),
      ['gluesync-chronos', 'gluesync-conductor'],
    );
    assert.deepEqual(
      unknown.containers.map(({ id }) => id),
      ['stray'],
    );
    await app.close();
  });

  it('redacts the environment for a role that cannot see it', async () => {
    const admin = await buildApp(swarmDocker(), SWARM, 'admin');
    const viewer = await buildApp(swarmDocker(), SWARM, 'viewer');

    const seenByAdmin = (await get(admin, '/containers')).containers.find(
      ({ id }) => id === 'gluesync-core-hub',
    );
    const seenByViewer = (await get(viewer, '/containers')).containers.find(
      ({ id }) => id === 'gluesync-core-hub',
    );

    assert.equal(
      seenByAdmin?.service.environment.GLUESYNC_ADMIN_PASSWORD,
      '${ADMIN_PASSWORD}',
    );
    assert.equal(
      seenByViewer?.service.environment.GLUESYNC_ADMIN_PASSWORD,
      '***REDACTED***',
    );
    // Not secret: left as it is
    assert.equal(
      seenByViewer?.service.environment.JAVA_OPTS,
      '-Xmx${CORE_HUB_HEAP:-4g}',
    );
    await Promise.all([admin.close(), viewer.close()]);
  });
});

describe('GET /containers in compose mode', () => {
  it('reads the containers of the node, not the swarm', async () => {
    const asked: unknown[] = [];
    const docker = {
      listContainers: async (options: unknown) => {
        asked.push(options);

        return [
          {
            Id: 'abc',
            Names: ['/gluesync-grafana'],
            Image: 'molo17/grafana:13.0.2.dashboard3',
            ImageID: 'sha256:1',
            Command: '',
            Created: 1,
            Ports: [],
            Labels: { 'com.docker.compose.service': 'grafana' },
            State: 'running',
            Status: 'Up 2 hours',
            HostConfig: { NetworkMode: 'default' },
            NetworkSettings: { Networks: {} },
            Mounts: [],
          },
        ];
      },
    } as unknown as Docker;
    const app = await buildApp(docker, { mode: 'compose' });

    const { containers } = await get(app, '/containers');
    const grafana = containers.find(({ id }) => id === 'grafana');

    assert.deepEqual(asked, [{ all: true }]);
    assert.equal(grafana?.info.id, 'abc');
    assert.equal(grafana?.info.swarm, undefined);
    assert.equal(grafana?.type, 'third-party');
    await app.close();
  });
});
