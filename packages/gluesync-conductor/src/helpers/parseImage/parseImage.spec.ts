/* eslint-disable no-template-curly-in-string -- Compose interpolations are the subject of this spec */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import parseImage from './parseImage';

const DIGEST =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('parseImage', () => {
  it('splits registry, repository and tag', () => {
    assert.deepEqual(parseImage('ghcr.io/org/gluesync-myapp:1.2.3'), {
      registry: 'ghcr.io',
      repository: 'org/gluesync-myapp',
      tag: '1.2.3',
      interpolatedTag: false,
      digest: '',
      fullName: 'ghcr.io/org/gluesync-myapp',
      original: 'ghcr.io/org/gluesync-myapp:1.2.3',
      imageName: 'gluesync-myapp',
      shortImageName: 'myapp',
    });
  });

  it('keeps the tag of an image pinned as repo:tag@digest', () => {
    const parsed = parseImage(`molo17/gluesync-core-hub:2.3.0@${DIGEST}`);

    assert.equal(parsed.tag, '2.3.0');
    assert.equal(parsed.digest, DIGEST);
    assert.equal(parsed.fullName, 'molo17/gluesync-core-hub');
    assert.equal(parsed.imageName, 'gluesync-core-hub');
    assert.equal(parsed.original, `molo17/gluesync-core-hub:2.3.0@${DIGEST}`);
  });

  it('has no tag for repo@digest, the digest is never the tag', () => {
    const parsed = parseImage(`molo17/gluesync-core-hub@${DIGEST}`);

    assert.equal(parsed.tag, '');
    assert.equal(parsed.digest, DIGEST);
    assert.equal(parsed.repository, 'molo17/gluesync-core-hub');
  });

  it('handles a registry with a port and a digest', () => {
    const parsed = parseImage(`nexus.local:5000/molo17/grafana:11@${DIGEST}`);

    assert.equal(parsed.registry, 'nexus.local:5000');
    assert.equal(parsed.repository, 'molo17/grafana');
    assert.equal(parsed.tag, '11');
  });

  it('returns empty parts for no image', () => {
    assert.equal(parseImage(undefined).tag, '');
    assert.equal(parseImage('').digest, '');
  });

  it('does not mistake the colon of ${TAG:-default} for the tag separator', () => {
    const parsed = parseImage('molo17/x:${TAG:-2.3.0}');

    assert.equal(parsed.tag, '');
    assert.equal(parsed.interpolatedTag, true);
    assert.equal(parsed.fullName, 'molo17/x');
    assert.equal(parsed.repository, 'molo17/x');
    assert.equal(parsed.original, 'molo17/x:${TAG:-2.3.0}');
  });

  it('treats plain and nested interpolated tags the same way', () => {
    ['molo17/x:${TAG}', 'molo17/x:$TAG', 'molo17/x:${A:-${B:-1.0}}'].forEach(
      image => {
        const parsed = parseImage(image);

        assert.equal(parsed.tag, '', image);
        assert.equal(parsed.interpolatedTag, true, image);
        assert.equal(parsed.fullName, 'molo17/x', image);
      },
    );
  });

  it('keeps a literal tag when only the registry is interpolated', () => {
    const parsed = parseImage('${REGISTRY:-nexus.local:5000}/molo17/x:2.3.0');

    assert.equal(parsed.tag, '2.3.0');
    assert.equal(parsed.interpolatedTag, false);
    assert.equal(parsed.fullName, '${REGISTRY:-nexus.local:5000}/molo17/x');
  });

  it('flags an interpolated tag that is followed by a digest', () => {
    const parsed = parseImage(`molo17/x:\${TAG:-1}@${DIGEST}`);

    assert.equal(parsed.tag, '');
    assert.equal(parsed.interpolatedTag, true);
    assert.equal(parsed.digest, DIGEST);
  });

  describe('where the registry starts', () => {
    it('reads a local image without a slash as a repository', () => {
      assert.deepEqual(parseImage('gluesync-conductor:swarm-dev'), {
        registry: '',
        repository: 'gluesync-conductor',
        tag: 'swarm-dev',
        interpolatedTag: false,
        digest: '',
        fullName: 'gluesync-conductor',
        original: 'gluesync-conductor:swarm-dev',
        imageName: 'gluesync-conductor',
        shortImageName: 'conductor',
      });
    });

    it('reads org/name:tag as a Docker Hub repository', () => {
      const parsed = parseImage('molo17/gluesync-core-hub:2.3.0');

      assert.equal(parsed.registry, '');
      assert.equal(parsed.repository, 'molo17/gluesync-core-hub');
      assert.equal(parsed.fullName, 'molo17/gluesync-core-hub');
      assert.equal(parsed.imageName, 'gluesync-core-hub');
      assert.equal(parsed.tag, '2.3.0');
    });

    it('takes localhost with a port as a registry', () => {
      const parsed = parseImage('localhost:5000/name:tag');

      assert.equal(parsed.registry, 'localhost:5000');
      assert.equal(parsed.repository, 'name');
      assert.equal(parsed.fullName, 'localhost:5000/name');
      assert.equal(parsed.tag, 'tag');
    });

    it('takes a bare localhost as a registry when a path follows', () => {
      const parsed = parseImage('localhost/name');

      assert.equal(parsed.registry, 'localhost');
      assert.equal(parsed.repository, 'name');
    });

    it('splits a registry host, tag and digest', () => {
      const parsed = parseImage(`registry.example.com/org/name:tag@${DIGEST}`);

      assert.equal(parsed.registry, 'registry.example.com');
      assert.equal(parsed.repository, 'org/name');
      assert.equal(parsed.fullName, 'registry.example.com/org/name');
      assert.equal(parsed.tag, 'tag');
      assert.equal(parsed.digest, DIGEST);
    });

    it('has no registry nor tag for a bare name', () => {
      const parsed = parseImage('name');

      assert.equal(parsed.registry, '');
      assert.equal(parsed.repository, 'name');
      assert.equal(parsed.fullName, 'name');
      assert.equal(parsed.imageName, 'name');
      assert.equal(parsed.tag, '');
    });

    it('does not take the digest of a bare name for a registry', () => {
      const parsed = parseImage(`name:tag@${DIGEST}`);

      assert.equal(parsed.registry, '');
      assert.equal(parsed.repository, 'name');
      assert.equal(parsed.tag, 'tag');
    });
  });
});
