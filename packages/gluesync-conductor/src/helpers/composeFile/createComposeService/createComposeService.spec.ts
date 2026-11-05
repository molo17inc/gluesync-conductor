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

    it('uses the Windows paths for the logback file and the agent mounts', () => {
      process.env.IS_WINDOWS = 'true';
      const service = createComposeService('agent', base);

      assert.ok(
        service.environment?.includes(
          String.raw`LOG_CONFIG_FILE=C:\opt\gluesync\shared\logback.xml`,
        ),
      );
      assert.ok(
        service.volumes?.includes(
          String.raw`./logs/gs-agent-1:C:\opt\gluesync\logs`,
        ),
      );
      assert.ok(
        service.volumes?.includes(
          String.raw`./data/gs-agent-1:C:\opt\gluesync\data`,
        ),
      );
    });

    it('uses the Linux paths for the logback file and the agent mounts', () => {
      delete process.env.IS_WINDOWS;
      const service = createComposeService('agent', base);

      assert.ok(
        service.environment?.includes(
          'LOG_CONFIG_FILE=/opt/gluesync/shared/logback.xml',
        ),
      );
      assert.ok(
        service.volumes?.includes('./logs/gs-agent-1:/opt/gluesync/logs:z'),
      );
      assert.ok(
        service.volumes?.includes('./data/gs-agent-1:/opt/gluesync/data:z'),
      );
    });

    it('does not put the SELinux flag on the Windows agent mounts', () => {
      process.env.IS_WINDOWS = 'true';
      const { volumes } = createComposeService('agent', base);

      assert.equal(
        volumes?.some(volume => String(volume).endsWith(':z')),
        false,
      );
    });

    it('does not put the SELinux flag on the agent mounts of a swarm stack', () => {
      delete process.env.IS_WINDOWS;
      const { volumes } = createComposeService('agent', { ...base, swarm: {} });

      assert.ok(volumes?.includes('./logs/gs-agent-1:/opt/gluesync/logs'));
    });

    it('does not label the mounts of a service that is not an agent', () => {
      delete process.env.IS_WINDOWS;
      const { volumes } = createComposeService('module', base);

      assert.equal(
        volumes?.some(volume => String(volume).includes('/logs')),
        false,
      );
    });
  });

  describe('volume options', () => {
    const volumesOf = (
      volumes: Parameters<typeof createComposeService>[1]['volumes'],
    ) => {
      delete process.env.IS_WINDOWS;
      return createComposeService('agent', { ...base, volumes }).volumes;
    };

    it('keeps the SELinux flags z and Z', () => {
      const volumes = volumesOf(['./a:/a:z', './b:/b:Z']);

      assert.ok(volumes?.includes('./a:/a:z'));
      assert.ok(volumes?.includes('./b:/b:Z'));
    });

    it('keeps the access mode next to the flag, access first', () => {
      const volumes = volumesOf(['./a:/a:ro,z', './b:/b:Z,rw', './c:/c:rw']);

      assert.ok(volumes?.includes('./a:/a:ro,z'));
      assert.ok(volumes?.includes('./b:/b:rw,Z'));
      assert.ok(volumes?.includes('./c:/c:rw'));
    });

    it('keeps the flags of the object form', () => {
      const volumes = volumesOf([
        { host: './a', container: '/a', mode: 'ro,z' },
        { host: './b', container: '/b', mode: 'z' },
      ]);

      assert.ok(volumes?.includes('./a:/a:ro,z'));
      assert.ok(volumes?.includes('./b:/b:z'));
    });

    it('still drops any other option', () => {
      const volumes = volumesOf(['./a:/a:cached', './b:/b:ro,nocopy']);

      assert.ok(volumes?.includes('./a:/a'));
      assert.ok(volumes?.includes('./b:/b:ro'));
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
