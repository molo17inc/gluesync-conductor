import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import buildModeUnknownReply from './buildModeUnknownReply';

describe('buildModeUnknownReply', () => {
  it('is an error body that carries the DOCKER_NOT_READY diagnosis', () => {
    const reply = buildModeUnknownReply();

    assert.equal(reply.success, false);
    assert.equal(reply.error, 'Docker is not ready');
    assert.equal(reply.diagnosis?.code, 'DOCKER_NOT_READY');
    assert.equal(reply.diagnosis?.owner, 'local');
  });
});
