import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import parseComposeFile from './parseComposeFile';
import { RawComposeFile } from '../../../models/composeFile.model';

// A service the way a Swarm stack file writes it
const stack: RawComposeFile = {
  services: {
    'core-hub': {
      image: 'molo17/gluesync-core-hub:2.3.0@sha256:abc',
      networks: ['gluesync-net'],
      environment: { JAVA_OPTS: '-Xmx2g', FLAG: 'true' },
      labels: ['com.molo17.conductor.type=core-hub'],
      ports: [
        { target: 1717, published: 1717, protocol: 'tcp', mode: 'host' },
        { target: 8080, published: 80, mode: 'ingress' },
        '9000:9000/udp',
      ],
      volumes: [
        { type: 'bind', source: './data', target: '/data' },
        {
          type: 'volume',
          source: 'hub-logs',
          target: '/logs',
          read_only: true,
        },
        '/etc/localtime:/etc/localtime:ro',
      ],
      deploy: {
        mode: 'replicated',
        replicas: 1,
        labels: ['com.molo17.conductor.type=core-hub'],
        placement: { constraints: ['node.role == manager'] },
        restart_policy: { condition: 'on-failure', max_attempts: 3 },
        update_config: { failure_action: 'rollback', monitor: '15s' },
        resources: { limits: { cpus: 2, memory: '4G' } },
      },
    },
  },
};

describe('parseComposeFile', () => {
  const service = parseComposeFile(stack).services?.['core-hub'];

  it('parses long-syntax volumes next to short ones', () => {
    assert.deepEqual(service?.volumes, [
      { host: './data', container: '/data' },
      { host: 'hub-logs', container: '/logs:ro' },
      { host: '/etc/localtime', container: '/etc/localtime:ro' },
    ]);
  });

  it('parses long-syntax ports next to short ones', () => {
    // Numeric host ports come out in ascending order (they are object keys)
    assert.deepEqual(service?.ports, [
      { host: '80', container: '8080' },
      { host: '1717', container: '1717' },
      { host: '9000', container: '9000/udp' },
    ]);
  });

  it('keeps the rest of the service, deploy included', () => {
    assert.equal(service?.image, 'molo17/gluesync-core-hub:2.3.0@sha256:abc');
    assert.equal(service?.deploy?.replicas, 1);
    assert.deepEqual(service?.deploy?.placement, {
      constraints: ['node.role == manager'],
    });
    assert.deepEqual(service?.labels, {
      'com.molo17.conductor.type': 'core-hub',
    });
    assert.deepEqual(service?.environment, {
      JAVA_OPTS: '-Xmx2g',
      FLAG: 'true',
    });
  });
});
