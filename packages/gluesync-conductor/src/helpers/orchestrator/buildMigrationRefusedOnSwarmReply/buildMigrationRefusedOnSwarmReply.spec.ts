import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import buildMigrationRefusedOnSwarmReply from './buildMigrationRefusedOnSwarmReply';

describe('buildMigrationRefusedOnSwarmReply', () => {
  it('is an error body that carries the SWARM_UNSUPPORTED diagnosis for the migration', () => {
    const reply = buildMigrationRefusedOnSwarmReply();

    assert.equal(reply.success, false);
    assert.equal(reply.diagnosis?.code, 'SWARM_UNSUPPORTED');
    assert.equal(reply.diagnosis?.params?.feature, 'migration-to-v2');
  });
});
