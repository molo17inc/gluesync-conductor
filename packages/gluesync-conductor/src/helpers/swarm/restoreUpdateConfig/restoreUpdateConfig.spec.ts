import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
  buildTask,
} from '../../../testing/fakeSwarmDocker';
import { UPDATE_CONFIG_LABEL } from '../swarm.model';
import restoreUpdateConfig, {
  restoreSelfUpdateConfig,
} from './restoreUpdateConfig';

const ROLLBACK_SETTINGS = {
  Parallelism: 1,
  Order: 'stop-first',
  FailureAction: 'rollback',
  Monitor: 15_000_000_000,
};

const STACK_SETTINGS = {
  Parallelism: 1,
  FailureAction: 'pause',
  Monitor: 5_000_000_000,
  MaxFailureRatio: 0,
  Order: 'stop-first',
};

const updated = (stashed: string) =>
  buildService('gluesync-core-hub', {
    labels: { [UPDATE_CONFIG_LABEL]: stashed, 'com.example': 'kept' },
    updateConfig: ROLLBACK_SETTINGS,
  });

// The clock and the sleep of waitForServiceConverged, for a service that is
// converged from the first look
const instant = {
  windowMs: 0,
  pollMs: 0,
  sleep: async () => undefined,
  now: () => 0,
};

describe('restoreUpdateConfig', () => {
  it('puts the stashed update settings back and drops the label', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [updated(JSON.stringify(STACK_SETTINGS))],
    });

    assert.equal(
      await restoreUpdateConfig(docker, 'gs_gluesync-core-hub'),
      'restored',
    );

    const { body } = calls.updates[0];

    assert.deepEqual(body.UpdateConfig, STACK_SETTINGS);
    assert.equal(UPDATE_CONFIG_LABEL in body.Labels, false);
    assert.equal(body.Labels['com.example'], 'kept');
    assert.equal(body.Labels['com.docker.stack.namespace'], 'gs');
  });

  it('leaves the task template alone, so no task is replaced', async () => {
    const service = updated(JSON.stringify(STACK_SETTINGS));
    const { docker, calls } = fakeSwarmDocker({ services: [service] });

    await restoreUpdateConfig(docker, 'gs_gluesync-core-hub');

    assert.deepEqual(
      calls.updates[0].body.TaskTemplate,
      service.Spec.TaskTemplate,
    );
  });

  it('removes the update settings of a service that had none', async () => {
    const { docker, calls } = fakeSwarmDocker({ services: [updated('null')] });

    await restoreUpdateConfig(docker, 'gs_gluesync-core-hub');

    assert.equal('UpdateConfig' in calls.updates[0].body, false);
  });

  it('keeps the current settings when the label is not ours to read', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [updated('not json')],
    });

    await restoreUpdateConfig(docker, 'gs_gluesync-core-hub');

    assert.deepEqual(calls.updates[0].body.UpdateConfig, ROLLBACK_SETTINGS);
    assert.equal(UPDATE_CONFIG_LABEL in calls.updates[0].body.Labels, false);
  });

  it('writes nothing when nothing is stashed', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('gluesync-core-hub')],
    });

    assert.equal(
      await restoreUpdateConfig(docker, 'gs_gluesync-core-hub'),
      'nothing-stashed',
    );
    assert.deepEqual(calls.updates, []);
  });
});

describe('restoreSelfUpdateConfig', () => {
  const conductor = (extra: Parameters<typeof buildService>[1] = {}) =>
    buildService('gluesync-conductor', {
      labels: { [UPDATE_CONFIG_LABEL]: JSON.stringify(STACK_SETTINGS) },
      updateConfig: ROLLBACK_SETTINGS,
      ...extra,
    });
  const running = buildTask('gluesync-conductor');

  it('restores once Swarm calls the update good', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [conductor({ state: 'completed' })],
      tasks: [running],
    });

    assert.equal(
      await restoreSelfUpdateConfig(docker, 'gs_gluesync-conductor', instant),
      'restored',
    );
    assert.deepEqual(calls.updates[0].body.UpdateConfig, STACK_SETTINGS);
  });

  it('leaves an update that rolled back to Swarm', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [conductor({ state: 'rollback_completed' })],
      tasks: [running],
    });

    assert.equal(
      await restoreSelfUpdateConfig(docker, 'gs_gluesync-conductor', instant),
      'not-converged',
    );
    assert.deepEqual(calls.updates, []);
  });

  it('does not wait when nothing is stashed', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('gluesync-conductor')],
    });

    assert.equal(
      await restoreSelfUpdateConfig(docker, 'gs_gluesync-conductor', instant),
      'nothing-stashed',
    );
    assert.deepEqual(calls.listTasks, []);
  });

  it('never throws', async () => {
    const { docker } = fakeSwarmDocker();

    assert.equal(
      await restoreSelfUpdateConfig(docker, 'gs_gluesync-conductor', instant),
      'failed',
    );
  });
});
