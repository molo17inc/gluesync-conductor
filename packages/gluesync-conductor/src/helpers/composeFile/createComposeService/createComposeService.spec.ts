import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import createComposeService from './createComposeService';

const originalWindows = process.env.IS_WINDOWS;

afterEach(() => {
  if (originalWindows === undefined) {
    delete process.env.IS_WINDOWS;
  } else {
    process.env.IS_WINDOWS = originalWindows;
  }
});

const base = {
  id: '1',
  serviceId: 'gs-agent-1',
  imageName: 'gluesync-agent',
  tag: '2.3.0',
  dependsOn: ['gluesync-core-hub'],
};

describe('createComposeService', () => {
  describe('compose', () => {
    it('keeps restart, depends_on and a plain deploy', () => {
      const service = createComposeService('agent', {
        ...base,
        resources: { limits: { memory: '1g' } },
      });

      assert.equal(service.restart, 'unless-stopped');
      assert.deepEqual(service.deploy, {
        resources: { limits: { memory: '1g' } },
      });
      assert.deepEqual(service.depends_on, base.dependsOn);
      assert.deepEqual(service.networks, ['gluesync-net']);
    });

    it('has no deploy without resources', () => {
      assert.equal(createComposeService('agent', base).deploy, undefined);
    });

    it('joins the Windows network on Windows', () => {
      process.env.IS_WINDOWS = 'true';

      assert.deepEqual(createComposeService('agent', base).networks, [
        'gluesync-windows-net',
      ]);
    });
  });

  describe('swarm', () => {
    it('restarts on failure through deploy instead of `restart:`', () => {
      const service = createComposeService('agent', { ...base, swarm: {} });

      assert.equal('restart' in service, false);
      assert.deepEqual(service.deploy?.restart_policy, {
        condition: 'on-failure',
      });
    });

    it('has no depends_on and sits on the stack overlay network, also on Windows', () => {
      process.env.IS_WINDOWS = 'true';
      const service = createComposeService('agent', { ...base, swarm: {} });

      assert.equal(service.depends_on, undefined);
      assert.deepEqual(service.networks, ['gluesync-net']);
      assert.equal(
        (service as Record<string, unknown>).container_name,
        undefined,
      );
    });

    it('keeps the resources next to the restart policy', () => {
      const service = createComposeService('agent', {
        ...base,
        resources: { reservations: { cpus: 1 } },
        swarm: {},
      });

      assert.deepEqual(service.deploy, {
        restart_policy: { condition: 'on-failure' },
        resources: { reservations: { cpus: 1 } },
      });
    });

    it('keeps the placement and the replicas of the service being edited', () => {
      const service = createComposeService('agent', {
        ...base,
        resources: { limits: { memory: '2g' } },
        swarm: {
          currentDeploy: {
            replicas: 0,
            placement: { constraints: ['node.hostname == db1'] },
            restart_policy: { condition: 'any' },
            resources: { limits: { memory: '1g' } },
          },
        },
      });

      assert.deepEqual(service.deploy, {
        replicas: 0,
        placement: { constraints: ['node.hostname == db1'] },
        restart_policy: { condition: 'any' },
        resources: { limits: { memory: '2g' } },
      });
    });

    it('drops the old limits when the request has none', () => {
      const service = createComposeService('agent', {
        ...base,
        swarm: { currentDeploy: { resources: { limits: { memory: '1g' } } } },
      });

      assert.equal(service.deploy?.resources, undefined);
    });

    it('still writes the env_file', () => {
      assert.ok(createComposeService('agent', { ...base, swarm: {} }).env_file);
    });
  });
});
