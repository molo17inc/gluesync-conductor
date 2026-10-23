import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import scaleService from './scaleService';

describe('scaleService', () => {
  it('sets the replicas and sends the rest of the spec back', async () => {
    const service = buildService('core-hub', { replicas: 1, version: 9 });
    const { docker, calls } = fakeSwarmDocker({ services: [service] });

    const before = await scaleService(docker, 'gs_core-hub', 3);

    const { query, body } = calls.updates[0];

    assert.equal(before.replicas, 1);
    assert.deepEqual(query, { version: 9 });
    assert.deepEqual(body.Mode, { Replicated: { Replicas: 3 } });
    assert.deepEqual(body.TaskTemplate, service.Spec.TaskTemplate);
    assert.deepEqual(body.Labels, service.Spec.Labels);
  });

  it('can scale to zero (stop)', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('core-hub')],
    });

    await scaleService(docker, 'gs_core-hub', 0);

    assert.deepEqual(calls.updates[0].body.Mode, {
      Replicated: { Replicas: 0 },
    });
  });

  it('refuses a global service', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('agent', { global: true })],
    });

    await assert.rejects(
      scaleService(docker, 'gs_agent', 2),
      /gs_agent is not a replicated service/,
    );
    assert.equal(calls.updates.length, 0);
  });
});
