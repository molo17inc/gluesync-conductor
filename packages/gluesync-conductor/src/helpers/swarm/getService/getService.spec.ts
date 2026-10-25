import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import getService from './getService';

describe('getService', () => {
  it('maps the inspected service', async () => {
    const { docker } = fakeSwarmDocker({
      services: [buildService('chronos', { replicas: 3, version: 21 })],
    });

    const service = await getService(docker, 'gs_chronos');

    assert.equal(service.id, 'chronos');
    assert.equal(service.name, 'gs_chronos');
    assert.equal(service.replicas, 3);
    assert.equal(service.version, 21);
  });

  it('rejects when the service does not exist', async () => {
    const { docker } = fakeSwarmDocker();

    await assert.rejects(getService(docker, 'gs_ghost'), /no such service/);
  });
});
