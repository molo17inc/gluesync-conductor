import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
  buildTask,
} from '../../../testing/fakeSwarmDocker';
import { labStack, labStackWithoutTypes } from '../../../testing/labStack';
import parseComposeFile from '../../composeFile/parseComposeFile/parseComposeFile';
import listSwarmContainers from './listSwarmContainers';

const composeJson = parseComposeFile(labStack);

const NODES = [
  { ID: 'node-1', Description: { Hostname: 'manager-1' } },
  { ID: 'node-2', Description: { Hostname: 'worker-1' } },
];

const find = <T extends { id: string }>(items: ReadonlyArray<T>, id: string) =>
  items.find(item => item.id === id);

describe('listSwarmContainers', () => {
  it('lists the stack file services with no swarm service as not running', async () => {
    const { docker } = fakeSwarmDocker({ nodes: NODES });

    const items = await listSwarmContainers(docker, 'gs', composeJson);

    assert.deepEqual(
      items.map(({ id }) => id),
      [
        'reverse-proxy',
        'gluesync-core-hub',
        'gluesync-chronos',
        'prometheus',
        'grafana',
        'gluesync-conductor',
      ],
    );
    items.forEach(item => {
      assert.equal(item.persisted, true);
      assert.equal(item.info, undefined);
    });
  });

  it('keeps the stack file definition and the type of each service', async () => {
    const { docker } = fakeSwarmDocker({ nodes: NODES });

    const items = await listSwarmContainers(docker, 'gs', composeJson);

    assert.deepEqual(
      items.map(({ id, type }) => [id, type]),
      [
        // No label in the stack file: typed by name, as autoAdoptServices would
        ['reverse-proxy', 'third-party'],
        ['gluesync-core-hub', 'core-hub'],
        ['gluesync-chronos', 'module'],
        ['prometheus', 'third-party'],
        ['grafana', 'third-party'],
        ['gluesync-conductor', 'module'],
      ],
    );
    assert.equal(
      find(items, 'grafana')?.service?.image,
      'molo17/grafana:13.0.2.dashboard3',
    );
  });

  it('adds a service that is only in the swarm as not persisted', async () => {
    const { docker } = fakeSwarmDocker({
      nodes: NODES,
      services: [
        buildService('orphan', {
          labels: { 'com.molo17.conductor.type': 'agent' },
        }),
      ],
      tasks: [buildTask('orphan')],
    });

    const items = await listSwarmContainers(docker, 'gs', composeJson);
    const orphan = find(items, 'orphan');

    assert.equal(items.length, 7);
    assert.equal(orphan?.persisted, false);
    assert.equal(orphan?.service, undefined);
    assert.equal(orphan?.type, 'agent');
    assert.equal(orphan?.info?.id, 'orphan-container');
  });

  it('builds info from the newest running task with the swarm details', async () => {
    const { docker } = fakeSwarmDocker({
      nodes: NODES,
      services: [
        buildService('grafana', {
          image: 'molo17/grafana:13.0.2.dashboard3',
          replicas: 1,
          state: 'completed',
        }),
      ],
      tasks: [
        buildTask('grafana', {
          taskId: 'old',
          state: 'shutdown',
          desired: 'shutdown',
          createdAt: '2026-10-22T10:00:00.000000000Z',
          containerId: 'old-container',
        }),
        buildTask('grafana', {
          taskId: 'new',
          nodeId: 'node-2',
          createdAt: '2026-10-23T10:00:00.000000000Z',
          containerId: 'new-container',
          image: 'molo17/grafana:13.0.2.dashboard3@sha256:abc',
        }),
      ],
    });

    const grafana = find(
      await listSwarmContainers(docker, 'gs', composeJson),
      'grafana',
    );

    assert.equal(grafana?.info?.id, 'new-container');
    assert.equal(grafana?.info?.state, 'running');
    assert.equal(grafana?.info?.image, 'molo17/grafana:13.0.2.dashboard3');
    assert.equal(grafana?.info?.tag, '13.0.2.dashboard3');
    assert.deepEqual(grafana?.info?.swarm, {
      serviceId: 'grafana-sid',
      node: 'worker-1',
      replicas: 1,
      desiredReplicas: 1,
      updateState: 'completed',
    });
  });

  it('shows the newest task when none is running, and counts none', async () => {
    const { docker } = fakeSwarmDocker({
      nodes: NODES,
      services: [buildService('gluesync-core-hub', { replicas: 1 })],
      tasks: [
        buildTask('gluesync-core-hub', {
          taskId: 'older',
          state: 'failed',
          desired: 'shutdown',
          createdAt: '2026-10-23T09:00:00.000000000Z',
        }),
        buildTask('gluesync-core-hub', {
          taskId: 'newest',
          state: 'starting',
          createdAt: '2026-10-23T10:00:00.000000000Z',
        }),
      ],
    });

    const hub = find(
      await listSwarmContainers(docker, 'gs', composeJson),
      'gluesync-core-hub',
    );

    assert.equal(hub?.info?.name, 'gs_gluesync-core-hub.newest');
    assert.equal(hub?.info?.state, 'created');
    assert.equal(hub?.info?.swarm?.replicas, 0);
    assert.equal(hub?.info?.swarm?.desiredReplicas, 1);
  });

  it('asks for the tasks that are not running too', async () => {
    const { docker, calls } = fakeSwarmDocker({
      nodes: NODES,
      services: [buildService('grafana')],
      tasks: [buildTask('grafana')],
    });

    await listSwarmContainers(docker, 'gs', composeJson);

    assert.deepEqual(calls.listTasks, [
      { filters: { service: ['gs_grafana'] } },
    ]);
    // One node lookup for all services
    assert.equal(calls.listNodes, 1);
  });

  it('still lists when the nodes cannot be read', async () => {
    const { docker } = fakeSwarmDocker({
      listNodesFails: true,
      services: [buildService('grafana')],
      tasks: [buildTask('grafana', { nodeId: 'node-2' })],
    });

    const grafana = find(
      await listSwarmContainers(docker, 'gs', composeJson),
      'grafana',
    );

    assert.equal(grafana?.info?.swarm?.node, 'node-2');
  });

  describe('type', () => {
    const withService = (service: Record<string, unknown>) =>
      parseComposeFile({ services: { svc: { image: 'a:1', ...service } } });

    const typeOf = async (
      compose: ReturnType<typeof withService>,
      extra: Parameters<typeof buildService>[1] = {},
    ) => {
      const { docker } = fakeSwarmDocker({
        services: [buildService('svc', extra)],
        tasks: [buildTask('svc')],
      });

      return (await listSwarmContainers(docker, 'gs', compose))[0].type;
    };

    it('reads the stack file labels as a list or a map', async () => {
      assert.equal(
        await typeOf(
          withService({ labels: ['com.molo17.conductor.type=agent'] }),
        ),
        'agent',
      );
      assert.equal(
        await typeOf(
          withService({ labels: { 'com.molo17.conductor.type': 'module' } }),
        ),
        'module',
      );
    });

    it('reads deploy.labels as a list or a map', async () => {
      assert.equal(
        await typeOf(
          withService({
            deploy: { labels: ['com.molo17.conductor.type=agent'] },
          }),
        ),
        'agent',
      );
      assert.equal(
        await typeOf(
          withService({
            deploy: { labels: { 'com.molo17.conductor.type': 'core-hub' } },
          }),
        ),
        'core-hub',
      );
    });

    it('prefers the stack file over the swarm service', async () => {
      assert.equal(
        await typeOf(
          withService({ labels: ['com.molo17.conductor.type=agent'] }),
          { labels: { 'com.molo17.conductor.type': 'module' } },
        ),
        'agent',
      );
    });

    it('falls back to the service labels, then the container labels', async () => {
      assert.equal(
        await typeOf(withService({}), {
          labels: { 'com.molo17.conductor.type': 'module' },
        }),
        'module',
      );
      assert.equal(
        await typeOf(withService({}), {
          containerLabels: { 'com.molo17.conductor.type': 'third-party' },
        }),
        'third-party',
      );
    });

    it('infers the type of a stack file with no type label at all', async () => {
      const { docker } = fakeSwarmDocker({ nodes: NODES });

      const items = await listSwarmContainers(
        docker,
        'gs',
        parseComposeFile(labStackWithoutTypes),
      );

      assert.deepEqual(
        items.map(({ id, type }) => [id, type]),
        [
          ['reverse-proxy', 'third-party'],
          ['gluesync-core-hub', 'core-hub'],
          ['gluesync-chronos', 'module'],
          ['prometheus', 'third-party'],
          ['grafana', 'third-party'],
          ['gluesync-conductor', 'module'],
        ],
      );
    });

    it('infers an agent from its image, whatever the service is called', async () => {
      assert.equal(
        await typeOf(
          parseComposeFile({
            services: { svc: { image: 'molo17/gluesync-mssql-cdc:2.3.0' } },
          }),
        ),
        'agent',
      );
    });

    it('prefers a label over the inference', async () => {
      assert.equal(
        await typeOf(
          withService({
            image: 'molo17/gluesync-core-hub:2.3.0',
            labels: ['com.molo17.conductor.type=module'],
          }),
        ),
        'module',
      );
    });

    it('does not guess for a service it does not know', async () => {
      assert.equal(
        await typeOf(withService({ image: 'acme/my-app:1' })),
        'unknown',
      );
    });

    it('is unknown for a label that is not a Conductor type', async () => {
      assert.equal(
        await typeOf(
          withService({ labels: ['com.molo17.conductor.type=bogus'] }),
        ),
        'unknown',
      );
    });
  });

  it('gives the agent id of the stack file', async () => {
    const { docker } = fakeSwarmDocker();

    const items = await listSwarmContainers(
      docker,
      'gs',
      parseComposeFile({
        services: {
          mssql: { image: 'a:1', environment: { INITIAL_AGENT_ID: 12 } },
          other: { image: 'a:1' },
        },
      }),
    );

    assert.deepEqual(
      items.map(({ agentId }) => agentId),
      ['12', undefined],
    );
  });
});
