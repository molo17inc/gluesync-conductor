import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildService } from '../../../testing/fakeSwarmDocker';
import mapService from '../mapService/mapService';
import { SwarmTask } from '../swarm.model';
import mapTaskToContainerInfo from './mapTaskToContainerInfo';

const service = mapService(
  buildService('grafana', {
    image: 'molo17/grafana:13.0.2@sha256:aaaa',
    replicas: 2,
    state: 'completed',
    labels: { 'com.molo17.conductor.type': 'third-party' },
    containerLabels: { 'com.molo17.conductor.service_id': 'grafana-uid' },
  }) as never,
);

const task = (state: string, extra: Partial<SwarmTask> = {}): SwarmTask => ({
  taskId: 'task-1',
  nodeId: 'node-1',
  nodeName: 'manager-1',
  state,
  desiredState: 'running',
  containerId: 'container-1',
  createdAt: '2026-10-23T10:00:00.000000000Z',
  updatedAt: '2026-10-23T10:00:05.000000000Z',
  image: 'molo17/grafana:13.0.2',
  forceUpdate: 0,
  ...extra,
});

describe('mapTaskToContainerInfo', () => {
  it('gives the shape of a compose container, from the task', () => {
    const info = mapTaskToContainerInfo({
      service,
      task: task('running'),
      runningTasks: 2,
      wantedTasks: 2,
    });

    assert.equal(info.id, 'container-1');
    assert.equal(info.name, 'gs_grafana.task-1');
    assert.equal(info.image, 'molo17/grafana:13.0.2');
    assert.equal(info.tag, '13.0.2');
    assert.equal(info.parsedImage.imageName, 'grafana');
    assert.equal(info.state, 'running');
    assert.equal(info.status, 'running');
    assert.equal(info.created, Date.parse('2026-10-23T10:00:00Z') / 1000);
    assert.equal(info.type, 'third-party');
    assert.equal(info.uniqueId, 'grafana-uid');
    assert.equal(info.labels['com.docker.stack.namespace'], 'gs');
  });

  it('adds the swarm details', () => {
    const info = mapTaskToContainerInfo({
      service,
      task: task('running'),
      runningTasks: 1,
      wantedTasks: 2,
    });

    assert.deepEqual(info.swarm, {
      serviceId: 'grafana-sid',
      node: 'manager-1',
      replicas: 1,
      desiredReplicas: 2,
      updateState: 'completed',
    });
  });

  it('shows the node id when the hostname is unknown', () => {
    const info = mapTaskToContainerInfo({
      service,
      task: task('running', { nodeName: undefined }),
      runningTasks: 1,
      wantedTasks: 1,
    });

    assert.equal(info.swarm.node, 'node-1');
  });

  it('wants as many tasks as should run for a global service', () => {
    const global = mapService(buildService('agent', { global: true }) as never);

    const info = mapTaskToContainerInfo({
      service: global,
      task: task('running'),
      runningTasks: 2,
      wantedTasks: 3,
    });

    assert.equal(info.swarm.desiredReplicas, 3);
  });

  it('maps task states onto Docker container states', () => {
    const states = [
      'new',
      'pending',
      'assigned',
      'accepted',
      'preparing',
      'ready',
      'starting',
      'running',
      'complete',
      'shutdown',
      'failed',
      'rejected',
      'remove',
      'orphaned',
      'something-new',
    ].map(
      state =>
        mapTaskToContainerInfo({
          service,
          task: task(state),
          runningTasks: 0,
          wantedTasks: 1,
        }).state,
    );

    assert.deepEqual(states, [
      'created',
      'created',
      'created',
      'created',
      'created',
      'created',
      'created',
      'running',
      'exited',
      'exited',
      'exited',
      'exited',
      'removing',
      'dead',
      'unknown',
    ]);
  });

  it('puts the failure into the status', () => {
    const info = mapTaskToContainerInfo({
      service,
      task: task('failed', { err: 'task: non-zero exit (1)' }),
      runningTasks: 0,
      wantedTasks: 1,
    });

    assert.equal(info.status, 'failed: task: non-zero exit (1)');
  });

  it('falls back to the task id and the service image', () => {
    const info = mapTaskToContainerInfo({
      service,
      task: task('pending', {
        containerId: undefined,
        image: '',
        createdAt: '',
      }),
      runningTasks: 0,
      wantedTasks: 1,
    });

    assert.equal(info.id, 'task-1');
    assert.equal(info.image, 'molo17/grafana:13.0.2');
    assert.equal(info.created, 0);
  });

  it('lists the published ports and the mounts of the spec', () => {
    const published = mapService({
      ...buildService('proxy'),
      Spec: {
        ...buildService('proxy').Spec,
        EndpointSpec: {
          Ports: [
            { Protocol: 'tcp', TargetPort: 80, PublishedPort: 8080 },
            { Protocol: 'udp', TargetPort: 53 },
          ],
        },
        TaskTemplate: {
          ContainerSpec: {
            Image: 'traefik:v3.1',
            Mounts: [
              {
                Type: 'bind',
                Source: '/srv/data',
                Target: '/data',
                ReadOnly: true,
              },
              { Type: 'volume', Source: 'logs', Target: '/logs' },
            ],
          },
        },
      },
    } as never);

    const info = mapTaskToContainerInfo({
      service: published,
      task: task('running'),
      runningTasks: 1,
      wantedTasks: 1,
    });

    assert.deepEqual(info.ports, [
      { ip: '', privatePort: 80, publicPort: 8080, type: 'tcp' },
      { ip: '', privatePort: 53, publicPort: 0, type: 'udp' },
    ]);
    assert.deepEqual(
      info.mounts.map(({ source, destination, rw }) => [
        source,
        destination,
        rw,
      ]),
      [
        ['/srv/data', '/data', false],
        ['logs', '/logs', true],
      ],
    );
  });
});
