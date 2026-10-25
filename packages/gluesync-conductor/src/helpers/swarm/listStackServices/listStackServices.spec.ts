import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import listStackServices from './listStackServices';

describe('listStackServices', () => {
  it('asks for the services of the stack by label', async () => {
    const { docker, calls } = fakeSwarmDocker();

    await listStackServices(docker, 'gs');

    assert.deepEqual(calls.listServices, [
      { filters: { label: ['com.docker.stack.namespace=gs'] } },
    ]);
  });

  it('maps a service', async () => {
    const service = buildService('core-hub', {
      image: 'molo17/gluesync-core-hub:2.3.0@sha256:abc',
      replicas: 2,
      version: 12,
      labels: { 'com.molo17.conductor.type': 'core-hub' },
      containerLabels: { tier: 'backend' },
      state: 'completed',
    });
    const { docker } = fakeSwarmDocker({ services: [service] });

    assert.deepEqual(await listStackServices(docker, 'gs'), [
      {
        id: 'core-hub',
        serviceId: 'core-hub-sid',
        name: 'gs_core-hub',
        image: 'molo17/gluesync-core-hub:2.3.0',
        labels: {
          'com.docker.stack.namespace': 'gs',
          'com.molo17.conductor.type': 'core-hub',
        },
        containerLabels: { tier: 'backend' },
        replicas: 2,
        updateState: 'completed',
        updateMessage: undefined,
        version: 12,
        spec: service.Spec,
        previousSpec: undefined,
      },
    ]);
  });

  it('leaves replicas undefined for a global service', async () => {
    const { docker } = fakeSwarmDocker({
      services: [buildService('agent', { global: true })],
    });

    const [agent] = await listStackServices(docker, 'gs');

    assert.equal(agent.replicas, undefined);
  });

  it('keeps out services of other stacks', async () => {
    const other = buildService('grafana', {
      labels: { 'com.docker.stack.namespace': 'other' },
    });
    const { docker } = fakeSwarmDocker({
      services: [buildService('core-hub'), other],
    });

    const services = await listStackServices(docker, 'gs');

    assert.deepEqual(
      services.map(s => s.id),
      ['core-hub'],
    );
  });

  it('keeps the whole name as id when it lacks the namespace prefix', async () => {
    const service = buildService('core-hub');
    const renamed = {
      ...service,
      Spec: { ...service.Spec, Name: 'standalone' },
    };
    const { docker } = fakeSwarmDocker({ services: [renamed] });

    assert.equal((await listStackServices(docker, 'gs'))[0].id, 'standalone');
  });

  it('is empty without services', async () => {
    const { docker } = fakeSwarmDocker();

    assert.deepEqual(await listStackServices(docker, 'gs'), []);
  });
});
