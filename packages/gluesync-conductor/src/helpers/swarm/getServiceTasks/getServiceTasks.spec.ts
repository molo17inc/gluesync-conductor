import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, { buildTask } from '../../../testing/fakeSwarmDocker';
import getServiceTasks from './getServiceTasks';

const nodes = [
  { ID: 'node-1', Description: { Hostname: 'manager-1' } },
  { ID: 'node-2', Description: { Hostname: 'worker-1' } },
];

describe('getServiceTasks', () => {
  it('asks for the tasks of the service that should be running', async () => {
    const { docker, calls } = fakeSwarmDocker();

    await getServiceTasks(docker, 'gs_core-hub');

    assert.deepEqual(calls.listTasks, [
      {
        filters: {
          service: ['gs_core-hub'],
          'desired-state': ['running'],
        },
      },
    ]);
  });

  it('maps a task, with the node hostname and no digest on the image', async () => {
    const { docker } = fakeSwarmDocker({
      tasks: [
        buildTask('core-hub', {
          taskId: 't1',
          nodeId: 'node-2',
          containerId: 'abc123',
          message: 'started',
          forceUpdate: 3,
        }),
      ],
      nodes,
    });

    assert.deepEqual(await getServiceTasks(docker, 'gs_core-hub'), [
      {
        taskId: 't1',
        nodeId: 'node-2',
        nodeName: 'worker-1',
        state: 'running',
        desiredState: 'running',
        containerId: 'abc123',
        message: 'started',
        err: undefined,
        createdAt: '2026-10-23T10:00:00.000000000Z',
        updatedAt: '2026-10-23T10:00:05.000000000Z',
        image: 'molo17/gluesync-core-hub:2.3.0',
        forceUpdate: 3,
      },
    ]);
  });

  it('lists the nodes once, however many tasks there are', async () => {
    const { docker, calls } = fakeSwarmDocker({
      tasks: [
        buildTask('core-hub', { taskId: 'a' }),
        buildTask('core-hub', { taskId: 'b', nodeId: 'node-2' }),
      ],
      nodes,
    });

    const tasks = await getServiceTasks(docker, 'gs_core-hub');

    assert.equal(calls.listNodes, 1);
    assert.deepEqual(tasks.map(t => t.nodeName).sort(), [
      'manager-1',
      'worker-1',
    ]);
  });

  it('can skip the node lookup', async () => {
    const { docker, calls } = fakeSwarmDocker({
      tasks: [buildTask('core-hub')],
      nodes,
    });

    const [task] = await getServiceTasks(docker, 'gs_core-hub', {
      resolveNodes: false,
    });

    assert.equal(calls.listNodes, 0);
    assert.equal(task.nodeName, undefined);
  });

  it('still returns the tasks when the nodes cannot be listed', async () => {
    const { docker } = fakeSwarmDocker({
      tasks: [buildTask('core-hub')],
      listNodesFails: true,
    });

    const tasks = await getServiceTasks(docker, 'gs_core-hub');

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].nodeName, undefined);
  });

  it('puts the newest task first', async () => {
    const { docker } = fakeSwarmDocker({
      tasks: [
        buildTask('core-hub', {
          taskId: 'old',
          createdAt: '2026-10-23T10:00:00.12Z',
        }),
        buildTask('core-hub', {
          taskId: 'new',
          createdAt: '2026-10-23T10:00:00.123456789Z',
        }),
        buildTask('core-hub', {
          taskId: 'oldest',
          createdAt: '2026-10-22T10:00:00Z',
        }),
      ],
    });

    const tasks = await getServiceTasks(docker, 'gs_core-hub');

    assert.deepEqual(
      tasks.map(t => t.taskId),
      ['new', 'old', 'oldest'],
    );
  });

  it('includes stopped tasks on request, with why they failed', async () => {
    const { docker, calls } = fakeSwarmDocker({
      tasks: [
        buildTask('core-hub', { taskId: 'ok' }),
        buildTask('core-hub', {
          taskId: 'bad',
          desired: 'shutdown',
          state: 'rejected',
          err: 'No such image: molo17/nope:1',
        }),
      ],
    });

    const tasks = await getServiceTasks(docker, 'gs_core-hub', {
      includeStopped: true,
    });

    assert.deepEqual(calls.listTasks[0], {
      filters: { service: ['gs_core-hub'] },
    });
    assert.equal(tasks.length, 2);
    assert.equal(
      tasks.find(t => t.taskId === 'bad')?.err,
      'No such image: molo17/nope:1',
    );
  });
});
