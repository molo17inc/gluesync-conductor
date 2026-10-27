import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import { STACK_IMAGE_LABEL, UPDATE_CONFIG_LABEL } from '../swarm.model';
import updateServiceImage, {
  MIN_UPDATE_MONITOR_NS,
} from './updateServiceImage';

describe('updateServiceImage', () => {
  it('sets the image and keeps the rest of the container spec', async () => {
    const service = buildService('core-hub', {
      image: 'molo17/gluesync-core-hub:2.3.0@sha256:abc',
    });
    const { docker, calls } = fakeSwarmDocker({ services: [service] });

    const before = await updateServiceImage(
      docker,
      'gs_core-hub',
      'molo17/gluesync-core-hub:2.3.1',
    );

    const { query, body } = calls.updates[0];

    assert.equal(before.image, 'molo17/gluesync-core-hub:2.3.0');
    assert.deepEqual(query, { version: 7 });
    assert.deepEqual(body.TaskTemplate.ContainerSpec, {
      ...service.Spec.TaskTemplate.ContainerSpec,
      Image: 'molo17/gluesync-core-hub:2.3.1',
    });
    assert.equal(body.TaskTemplate.ForceUpdate, 0);
    assert.deepEqual(body.TaskTemplate.Placement, {
      Constraints: ['node.role == manager'],
    });
  });

  it('makes the update roll back on failure and monitor the new tasks', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('core-hub')],
    });

    await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

    assert.deepEqual(calls.updates[0].body.UpdateConfig, {
      Parallelism: 1,
      Order: 'stop-first',
      FailureAction: 'rollback',
      Monitor: MIN_UPDATE_MONITOR_NS,
    });
    assert.equal(MIN_UPDATE_MONITOR_NS, 15_000_000_000);
  });

  it('keeps the update config of the service, only forcing the rollback', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [
        buildService('core-hub', {
          updateConfig: {
            Parallelism: 2,
            Delay: 5_000_000_000,
            Order: 'start-first',
            FailureAction: 'pause',
            Monitor: 60_000_000_000,
          },
        }),
      ],
    });

    await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

    assert.deepEqual(calls.updates[0].body.UpdateConfig, {
      Parallelism: 2,
      Delay: 5_000_000_000,
      Order: 'start-first',
      FailureAction: 'rollback',
      Monitor: 60_000_000_000,
    });
  });

  it('raises a short monitor period to the minimum', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [
        buildService('core-hub', {
          updateConfig: {
            Parallelism: 1,
            Order: 'stop-first',
            Monitor: 5_000_000_000,
          },
        }),
      ],
    });

    await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

    assert.equal(
      calls.updates[0].body.UpdateConfig.Monitor,
      MIN_UPDATE_MONITOR_NS,
    );
  });

  it('makes no call when the image is the same and the rollback is set up', async () => {
    const service = buildService('core-hub', {
      image: 'molo17/hub:2@sha256:abc',
      updateConfig: {
        Parallelism: 1,
        FailureAction: 'rollback',
        Monitor: MIN_UPDATE_MONITOR_NS,
      },
    });
    const { docker, calls } = fakeSwarmDocker({ services: [service] });

    const current = await updateServiceImage(
      docker,
      'gs_core-hub',
      'molo17/hub:2',
    );

    assert.equal(current.image, 'molo17/hub:2');
    assert.equal(current.serviceId, 'core-hub-sid');
    assert.equal(calls.updates.length, 0);
  });

  it('still writes the rollback settings to a service already on the image', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('core-hub', { image: 'molo17/hub:2' })],
    });

    await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

    assert.equal(calls.updates.length, 1);
    assert.equal(calls.updates[0].body.UpdateConfig.FailureAction, 'rollback');
  });

  describe('the spec `docker stack deploy` would write', () => {
    it('pins the image to its registry digest, as --resolve-image always does', async () => {
      const { docker, calls } = fakeSwarmDocker({
        services: [buildService('core-hub')],
        digests: { 'molo17/hub:2': 'sha256:feed' },
      });

      await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

      assert.equal(
        calls.updates[0].body.TaskTemplate.ContainerSpec.Image,
        'molo17/hub:2@sha256:feed',
      );
    });

    it('labels the service with the image of the stack file', async () => {
      const { docker, calls } = fakeSwarmDocker({
        services: [
          buildService('core-hub', {
            labels: { [STACK_IMAGE_LABEL]: 'molo17/hub:1' },
          }),
        ],
        digests: { 'molo17/hub:2': 'sha256:feed' },
      });

      await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

      assert.equal(
        calls.updates[0].body.Labels[STACK_IMAGE_LABEL],
        'molo17/hub:2',
      );
    });

    it('adds no stack image label to a service that was not deployed as a stack', async () => {
      const { docker, calls } = fakeSwarmDocker({
        services: [buildService('core-hub')],
      });

      await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

      assert.equal(STACK_IMAGE_LABEL in calls.updates[0].body.Labels, false);
    });

    it('stashes the update settings of the service for restoreUpdateConfig', async () => {
      const own = {
        Parallelism: 1,
        FailureAction: 'pause',
        Monitor: 5_000_000_000,
        MaxFailureRatio: 0,
        Order: 'stop-first',
      };
      const { docker, calls } = fakeSwarmDocker({
        services: [buildService('core-hub', { updateConfig: own })],
      });

      await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

      assert.deepEqual(
        JSON.parse(calls.updates[0].body.Labels[UPDATE_CONFIG_LABEL]),
        own,
      );
    });

    it('stashes null for a service with no update settings', async () => {
      const { docker, calls } = fakeSwarmDocker({
        services: [buildService('core-hub')],
      });

      await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

      assert.equal(calls.updates[0].body.Labels[UPDATE_CONFIG_LABEL], 'null');
    });

    it('does not stash the rollback settings over the ones a retry finds stashed', async () => {
      const { docker, calls } = fakeSwarmDocker({
        services: [
          buildService('core-hub', {
            labels: { [UPDATE_CONFIG_LABEL]: '{"FailureAction":"pause"}' },
            updateConfig: { FailureAction: 'rollback', Monitor: 1 },
          }),
        ],
      });

      await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

      assert.equal(
        calls.updates[0].body.Labels[UPDATE_CONFIG_LABEL],
        '{"FailureAction":"pause"}',
      );
    });

    it('keeps the pinned image of a service already on it', async () => {
      const { docker, calls } = fakeSwarmDocker({
        services: [
          buildService('core-hub', { image: 'molo17/hub:2@sha256:abc' }),
        ],
        digests: { 'molo17/hub:2': 'sha256:other' },
      });

      await updateServiceImage(docker, 'gs_core-hub', 'molo17/hub:2');

      assert.equal(
        calls.updates[0].body.TaskTemplate.ContainerSpec.Image,
        'molo17/hub:2@sha256:abc',
      );
      assert.deepEqual(calls.distributions, []);
    });
  });
});
