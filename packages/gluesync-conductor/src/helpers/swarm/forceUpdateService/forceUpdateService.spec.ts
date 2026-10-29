import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import forceUpdateService from './forceUpdateService';

describe('forceUpdateService', () => {
  it('increments ForceUpdate and leaves the rest of the task template', async () => {
    const service = buildService('core-hub', { forceUpdate: 4 });
    const { docker, calls } = fakeSwarmDocker({ services: [service] });

    await forceUpdateService(docker, 'gs_core-hub');

    const { query, body } = calls.updates[0];

    assert.deepEqual(query, { version: 7 });
    assert.deepEqual(body.TaskTemplate, {
      ...service.Spec.TaskTemplate,
      ForceUpdate: 5,
    });
    assert.deepEqual(body.Mode, service.Spec.Mode);
  });

  it('starts at 1 for a service never forced', async () => {
    const service = buildService('core-hub');
    const template = Object.fromEntries(
      Object.entries(service.Spec.TaskTemplate).filter(
        ([key]) => key !== 'ForceUpdate',
      ),
    );
    const { docker, calls } = fakeSwarmDocker({
      services: [
        { ...service, Spec: { ...service.Spec, TaskTemplate: template } },
      ],
    });

    await forceUpdateService(docker, 'gs_core-hub');

    assert.equal(calls.updates[0].body.TaskTemplate.ForceUpdate, 1);
  });
});
