import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import mergeComposeFiles, { mergeServices } from './mergeComposeFiles';
import { RawComposeService } from '../../../models/composeFile.model';

const service = (extra: Partial<RawComposeService>): RawComposeService => ({
  image: 'molo17/gluesync-core-hub:2.3.0',
  ...extra,
});

const merge = (
  service1: Partial<RawComposeService>,
  service2: Partial<RawComposeService>,
) => mergeServices([{ a: service(service1) }, { a: service(service2) }]).a;

describe('mergeTwoServices (via mergeServices)', () => {
  describe('deploy', () => {
    const base = {
      mode: 'replicated',
      replicas: 2,
      placement: { constraints: ['node.role == manager'] },
      restart_policy: { condition: 'on-failure' },
      update_config: { failure_action: 'rollback', monitor: '15s' },
      labels: ['com.molo17.conductor.type=core-hub'],
    } as const;

    it('keeps every deploy key when only resources are edited', () => {
      const merged = merge(
        { deploy: { ...base, resources: { limits: { cpus: 1 } } } },
        { deploy: { resources: { limits: { cpus: 4, memory: '8G' } } } },
      );

      assert.deepEqual(merged.deploy, {
        ...base,
        resources: { limits: { cpus: 4, memory: '8G' } },
      });
    });

    it('keeps deploy keys when the later service has no deploy', () => {
      assert.deepEqual(merge({ deploy: base }, {}).deploy, base);
    });

    it('lets the later service override single deploy keys', () => {
      const merged = merge({ deploy: base }, { deploy: { replicas: 3 } });

      assert.equal(merged.deploy?.replicas, 3);
      assert.deepEqual(merged.deploy?.placement, base.placement);
    });

    it('still merges resources like before', () => {
      const merged = merge(
        {
          deploy: {
            resources: {
              limits: { cpus: 1, memory: '1G' },
              reservations: { memory: '512M' },
            },
          },
        },
        { deploy: { resources: { limits: { cpus: 2 } } } },
      );

      assert.deepEqual(merged.deploy?.resources, {
        limits: { cpus: 2, memory: '1G' },
        reservations: { memory: '512M' },
      });
    });

    it('drops resources that the later service blanks out', () => {
      const merged = merge(
        { deploy: { replicas: 1, resources: { limits: { cpus: 1 } } } },
        { deploy: { resources: { limits: { cpus: null } } } },
      );

      assert.deepEqual(merged.deploy, { replicas: 1 });
    });

    it('adds no deploy when neither service has one', () => {
      assert.equal('deploy' in merge({}, {}), false);
    });
  });

  describe('long-syntax ports and volumes', () => {
    it('passes them through untouched next to short entries', () => {
      const longVolume = {
        type: 'bind',
        source: './data',
        target: '/data',
        read_only: true,
      } as const;
      const longPort = { target: 80, published: 8080, mode: 'host' } as const;

      const merged = merge(
        { volumes: [longVolume, '/a:/b'], ports: [longPort, '1:1'] },
        { volumes: ['/a:/c'], ports: ['2:2'] },
      );

      assert.deepEqual(merged.volumes, ['/a:/c', longVolume]);
      assert.deepEqual(merged.ports, ['1:1', '2:2', longPort]);
    });

    it('keeps the later long entry when both services have the same mount', () => {
      const merged = merge(
        { volumes: [{ source: 'v', target: '/data' }] },
        { volumes: [{ source: 'v', target: '/data', read_only: true }] },
      );

      assert.deepEqual(merged.volumes, [
        { source: 'v', target: '/data', read_only: true },
      ]);
    });

    it('does not crash when only one side has long entries', () => {
      const merged = merge({}, { ports: [{ target: 80, published: 80 }] });

      assert.deepEqual(merged.ports, [{ target: 80, published: 80 }]);
    });
  });

  it('merges environment and labels as before', () => {
    const merged = merge(
      { environment: ['A=1', 'B=2'], labels: { x: '1' } },
      { environment: ['B=3'], labels: { y: '2' } },
    );

    assert.deepEqual(merged.environment, ['A=1', 'B=3']);
    assert.deepEqual(merged.labels, ['x=1', 'y=2']);
  });
});

describe('mergeComposeFiles', () => {
  it('keeps long-syntax entries and deploy keys across files', () => {
    const merged = mergeComposeFiles([
      {
        services: {
          hub: service({
            ports: [{ target: 80, published: 80 }],
            deploy: { replicas: 2 },
          }),
        },
      },
      {
        services: {
          hub: service({ deploy: { resources: { limits: { cpus: 2 } } } }),
        },
      },
    ]);

    assert.deepEqual(merged.services?.hub.ports, [
      { target: 80, published: 80 },
    ]);
    assert.deepEqual(merged.services?.hub.deploy, {
      replicas: 2,
      resources: { limits: { cpus: 2 } },
    });
  });
});
