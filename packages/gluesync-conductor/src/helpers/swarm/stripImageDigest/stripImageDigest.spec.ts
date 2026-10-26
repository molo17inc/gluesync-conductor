import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import stripImageDigest from './stripImageDigest';

describe('stripImageDigest', () => {
  it('removes the digest and keeps the tag', () => {
    assert.equal(
      stripImageDigest('molo17/core-hub:2.3.0@sha256:0123abcd'),
      'molo17/core-hub:2.3.0',
    );
  });

  it('removes the digest of an image without tag', () => {
    assert.equal(
      stripImageDigest('nexus:5000/core-hub@sha256:0123abcd'),
      'nexus:5000/core-hub',
    );
  });

  it('leaves an image without digest alone', () => {
    assert.equal(stripImageDigest('grafana/grafana:11'), 'grafana/grafana:11');
    assert.equal(stripImageDigest(''), '');
  });
});
