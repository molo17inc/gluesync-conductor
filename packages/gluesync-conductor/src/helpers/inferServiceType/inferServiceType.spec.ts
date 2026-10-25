import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import inferServiceType, { inferTypeFromAgentsJson } from './inferServiceType';

describe('inferServiceType', () => {
  it('takes the stack names of third-party services as third-party', () => {
    ['reverse-proxy', 'grafana', 'prometheus', 'portainer'].forEach(id => {
      assert.equal(inferServiceType(id, 'any/image:1'), 'third-party', id);
    });
  });

  it('takes Core Hub as core-hub', () => {
    assert.equal(
      inferServiceType('hub', 'molo17/gluesync-core-hub:2.3.0'),
      'core-hub',
    );
  });

  it('takes a source or target connector as an agent', () => {
    assert.equal(
      inferServiceType('pg', 'molo17/gluesync-postgresql-cdc:2.3.0'),
      'agent',
    );
    assert.equal(
      inferServiceType('target', 'molo17/gluesync-snowflake:2.3.0'),
      'agent',
    );
  });

  it('takes Chronos and Conductor as modules', () => {
    assert.equal(
      inferServiceType('gluesync-chronos', 'molo17/gluesync-chronos:0.2.4'),
      'module',
    );
    assert.equal(
      inferServiceType('c', 'gluesync-conductor:swarm-dev'),
      'module',
    );
  });

  it('reads the image behind a registry, a tag and a digest', () => {
    assert.equal(
      inferServiceType(
        'pg',
        'registry.example.com:5000/molo17/gluesync-mysql:1@sha256:abc',
      ),
      'agent',
    );
  });

  it('has no type for a service it does not know', () => {
    assert.equal(inferServiceType('my-app', 'acme/my-app:1'), null);
    assert.equal(inferServiceType('my-app', undefined), null);
  });

  it('matches agents.json by image name only', () => {
    assert.equal(inferTypeFromAgentsJson('gluesync-oracle-logminer'), 'agent');
    assert.equal(inferTypeFromAgentsJson('nope'), null);
  });
});
