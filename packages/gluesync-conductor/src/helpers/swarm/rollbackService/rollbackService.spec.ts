import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import rollbackService from './rollbackService';

describe('rollbackService', () => {
  it('updates with the current spec and rollback=previous', async () => {
    const service = buildService('core-hub', {
      version: 11,
      image: 'molo17/hub:2',
      previousSpec: { Name: 'gs_core-hub' },
    });
    const { docker, calls } = fakeSwarmDocker({ services: [service] });

    const before = await rollbackService(docker, 'gs_core-hub');

    assert.equal(before.image, 'molo17/hub:2');
    assert.deepEqual(calls.updates[0].query, {
      rollback: 'previous',
      version: 11,
    });
    assert.deepEqual(calls.updates[0].body, service.Spec);
  });

  it('rejects, without calling the API, when there is nothing to go back to', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('core-hub')],
    });

    await assert.rejects(
      rollbackService(docker, 'gs_core-hub'),
      /gs_core-hub has no previous version to roll back to/,
    );
    assert.equal(calls.updates.length, 0);
  });
});
