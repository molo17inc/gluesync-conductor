import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import compareImageTags, { parseTag } from './imageTagOrder';

describe('compareImageTags', () => {
  it('finds equal tags equal', () => {
    assert.equal(compareImageTags('2.3.1.4', '2.3.1.4'), 'equal');
    assert.equal(
      compareImageTags('2.3.2.0.4dbdd8aa7e', '2.3.2.0.4dbdd8aa7e'),
      'equal',
    );
  });

  it('finds the compose tag older than the running one (2026-11-07)', () => {
    assert.equal(compareImageTags('2.3.1.3', '2.3.1.4'), 'older');
    assert.equal(compareImageTags('2.3.1.4', '2.3.2.0'), 'older');
    assert.equal(compareImageTags('2.2.11.6', '2.3.0.0'), 'older');
  });

  it('finds the compose tag newer than the running one', () => {
    assert.equal(compareImageTags('2.3.1.4', '2.3.1.3'), 'newer');
    assert.equal(compareImageTags('2.3.2.0', '2.3.1.4'), 'newer');
  });

  it('compares parts as numbers, not text', () => {
    assert.equal(compareImageTags('2.3.1.9', '2.3.1.10'), 'older');
    assert.equal(compareImageTags('2.10.0.0', '2.9.9.9'), 'newer');
  });

  it('reads missing parts as zero', () => {
    assert.equal(compareImageTags('2.3', '2.3.0.0'), 'equal');
    assert.equal(compareImageTags('0.14.0', '0.14.1'), 'older');
  });

  it('puts a beta/alpha build before its release and after the one before', () => {
    assert.equal(compareImageTags('2.3.2.0.4dbdd8aa7e', '2.3.2.0'), 'older');
    assert.equal(compareImageTags('2.3.2.0', '2.3.2.0.4dbdd8aa7e'), 'newer');
    assert.equal(compareImageTags('2.3.1.4', '2.3.2.0.4dbdd8aa7e'), 'older');
    assert.equal(compareImageTags('2.3.2.0.4dbdd8aa7e', '2.3.1.4'), 'newer');
  });

  it('reads a commit made of digits only as a build, not a fifth part', () => {
    assert.equal(compareImageTags('2.3.2.0.1234567', '2.3.2.0'), 'older');
  });

  it('cannot order two builds of the same release', () => {
    assert.equal(
      compareImageTags('2.3.2.0.4dbdd8aa7e', '2.3.2.0.0c1f2e3a9b'),
      'unknown',
    );
  });

  it('orders builds of different releases by their release', () => {
    assert.equal(
      compareImageTags('2.3.1.4.aaaaaaa', '2.3.2.0.4dbdd8aa7e'),
      'older',
    );
  });

  it('ignores an image variant suffix', () => {
    assert.equal(compareImageTags('2.3.1.4-debian', '2.3.1.4'), 'equal');
    assert.equal(compareImageTags('2.3.1.3-debian', '2.3.1.4-debian'), 'older');
  });

  it('cannot order tags that are not versions', () => {
    ['latest', '', 'v3.1', 'dev', '2.3.x', '2', 'swarm-dev'].forEach(tag => {
      assert.equal(compareImageTags(tag, '2.3.1.4'), 'unknown', tag);
      assert.equal(compareImageTags('2.3.1.4', tag), 'unknown', tag);
    });
  });
});

describe('parseTag', () => {
  it('splits release and build', () => {
    assert.deepEqual(parseTag('2.3.2.0.4dbdd8aa7e'), {
      release: [2, 3, 2, 0],
      build: '4dbdd8aa7e',
    });
    assert.deepEqual(parseTag('2.3.1.4'), { release: [2, 3, 1, 4] });
  });

  it('refuses more than one trailing non-release part', () => {
    assert.equal(parseTag('2.3.1.4.abcdef1.abcdef2'), undefined);
  });
});
