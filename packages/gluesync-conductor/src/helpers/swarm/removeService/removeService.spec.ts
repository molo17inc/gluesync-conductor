import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import removeService from './removeService';

describe('removeService', () => {
  it('removes the service by its full name', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('grafana')],
    });

    await removeService(docker, 'gs_grafana');

    assert.deepEqual(calls.removed, ['gs_grafana']);
  });

  it('rejects when the service does not exist', async () => {
    const { docker } = fakeSwarmDocker();

    await assert.rejects(removeService(docker, 'gs_ghost'), /no such service/);
  });
});
