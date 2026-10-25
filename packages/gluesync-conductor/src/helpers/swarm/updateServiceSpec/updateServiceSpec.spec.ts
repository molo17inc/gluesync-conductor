import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import updateServiceSpec from './updateServiceSpec';

describe('updateServiceSpec', () => {
  it('sends the current version in the query and the changed spec as body', async () => {
    const service = buildService('core-hub', { version: 42 });
    const { docker, calls } = fakeSwarmDocker({ services: [service] });

    await updateServiceSpec(docker, 'gs_core-hub', spec => ({
      ...spec,
      Labels: { ...spec.Labels, touched: 'yes' },
    }));

    assert.equal(calls.updates.length, 1);
    assert.equal(calls.updates[0].id, 'gs_core-hub');
    assert.deepEqual(calls.updates[0].query, { version: 42 });
    assert.deepEqual(calls.updates[0].body, {
      ...service.Spec,
      Labels: { ...service.Spec.Labels, touched: 'yes' },
    });
  });

  it('keeps every part of the spec the change does not touch', async () => {
    const service = buildService('core-hub');
    const { docker, calls } = fakeSwarmDocker({ services: [service] });

    await updateServiceSpec(docker, 'gs_core-hub', spec => spec);

    assert.deepEqual(calls.updates[0].body, service.Spec);
  });

  it('adds extra query parameters next to the version', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('core-hub', { version: 3 })],
    });

    await updateServiceSpec(docker, 'gs_core-hub', spec => spec, {
      query: { rollback: 'previous' },
    });

    assert.deepEqual(calls.updates[0].query, {
      rollback: 'previous',
      version: 3,
    });
  });

  it('returns the service as it was before', async () => {
    const { docker } = fakeSwarmDocker({
      services: [buildService('core-hub', { image: 'molo17/hub:1' })],
    });

    const before = await updateServiceSpec(docker, 'gs_core-hub', s => s);

    assert.equal(before.image, 'molo17/hub:1');
  });

  it('hands the change the mapped service too', async () => {
    const { docker } = fakeSwarmDocker({
      services: [buildService('core-hub', { replicas: 4 })],
    });

    await updateServiceSpec(docker, 'gs_core-hub', (spec, current) => {
      assert.equal(current.replicas, 4);
      return spec;
    });
  });

  it('retries once, on a fresh version, when the service changed meanwhile', async () => {
    const versions = [5, 6];
    const { docker, calls } = fakeSwarmDocker({
      services: () => [
        buildService('core-hub', { version: versions.shift() ?? 6 }),
      ],
      updateErrors: [
        new Error('(HTTP code 500) server error - update out of sequence'),
      ],
    });

    await updateServiceSpec(docker, 'gs_core-hub', s => s);

    assert.equal(calls.updates.length, 1);
    assert.deepEqual(calls.updates[0].query, { version: 6 });
  });

  it('does not retry forever', async () => {
    const outOfSequence = new Error('update out of sequence');
    const { docker } = fakeSwarmDocker({
      services: [buildService('core-hub')],
      updateErrors: [outOfSequence, outOfSequence],
    });

    await assert.rejects(
      updateServiceSpec(docker, 'gs_core-hub', s => s),
      /update out of sequence/,
    );
  });

  it('passes other errors through', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('core-hub')],
      updateErrors: [new Error('rpc error: name conflicts')],
    });

    await assert.rejects(
      updateServiceSpec(docker, 'gs_core-hub', s => s),
      /name conflicts/,
    );
    assert.equal(calls.updates.length, 0);
  });

  it('rejects for a service that does not exist', async () => {
    const { docker } = fakeSwarmDocker();

    await assert.rejects(
      updateServiceSpec(docker, 'gs_ghost', s => s),
      /no such service/,
    );
  });

  it('sends nothing when the change throws', async () => {
    const { docker, calls } = fakeSwarmDocker({
      services: [buildService('core-hub')],
    });

    await assert.rejects(
      updateServiceSpec(docker, 'gs_core-hub', () => {
        throw new Error('refused');
      }),
      /refused/,
    );
    assert.equal(calls.updates.length, 0);
  });
});
