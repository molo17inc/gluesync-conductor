/* eslint-disable no-template-curly-in-string -- compose interpolations are plain strings in these specs */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalImageName,
  imageNameVariants,
  isSameImage,
  qualifiedImageName,
} from './canonicalImage';

describe('canonicalImageName', () => {
  it('strips docker.io from what Podman reports for a molo17 image', () => {
    assert.equal(
      canonicalImageName('docker.io/molo17/gluesync-core-hub:2.3.0.0'),
      'molo17/gluesync-core-hub:2.3.0.0',
    );
  });

  it('strips index.docker.io and registry-1.docker.io too', () => {
    assert.equal(
      canonicalImageName('index.docker.io/molo17/x:1'),
      'molo17/x:1',
    );
    assert.equal(
      canonicalImageName('registry-1.docker.io/molo17/x:1'),
      'molo17/x:1',
    );
  });

  it('strips library/ of an official image', () => {
    assert.equal(
      canonicalImageName('docker.io/library/busybox:1.36'),
      'busybox:1.36',
    );
    assert.equal(canonicalImageName('library/busybox'), 'busybox');
    assert.equal(
      canonicalImageName('docker.io/library/y@sha256:abc'),
      'y@sha256:abc',
    );
  });

  it('keeps library/ when more path follows it', () => {
    assert.equal(
      canonicalImageName('docker.io/library/team/app:1'),
      'library/team/app:1',
    );
  });

  it('leaves a short name and another registry alone', () => {
    [
      'molo17/traefik:3.6.2',
      'busybox',
      'ghcr.io/org/x:1',
      'localhost:5000/x',
    ].forEach(image => {
      assert.equal(canonicalImageName(image), image);
    });
  });

  it('leaves a compose interpolation alone', () => {
    assert.equal(
      canonicalImageName('molo17/gluesync-core-hub:${TAG:-2.3.0}'),
      'molo17/gluesync-core-hub:${TAG:-2.3.0}',
    );
  });
});

describe('qualifiedImageName', () => {
  it('names an official image the way Podman does', () => {
    assert.equal(
      qualifiedImageName('docker:cli'),
      'docker.io/library/docker:cli',
    );
    assert.equal(
      qualifiedImageName('docker.io/library/docker:cli'),
      'docker.io/library/docker:cli',
    );
  });

  it('names a Docker Hub user image', () => {
    assert.equal(qualifiedImageName('molo17/x:1'), 'docker.io/molo17/x:1');
  });

  it('leaves another registry alone', () => {
    assert.equal(qualifiedImageName('ghcr.io/org/x:1'), 'ghcr.io/org/x:1');
    assert.equal(
      qualifiedImageName('localhost:5000/x:1'),
      'localhost:5000/x:1',
    );
  });
});

describe('imageNameVariants', () => {
  it('lists the short and the qualified spelling once each', () => {
    assert.deepEqual(imageNameVariants('molo17/x:1'), [
      'molo17/x:1',
      'docker.io/molo17/x:1',
    ]);
    assert.deepEqual(imageNameVariants('docker.io/library/docker:cli'), [
      'docker.io/library/docker:cli',
      'docker:cli',
    ]);
  });

  it('keeps an interpolated name as it is', () => {
    assert.deepEqual(imageNameVariants('${REG}/x:1'), ['${REG}/x:1']);
  });
});

describe('isSameImage', () => {
  it('matches the two spellings of one image', () => {
    assert.equal(isSameImage('docker.io/molo17/x:1', 'molo17/x:1'), true);
    assert.equal(isSameImage('docker.io/library/busybox:1', 'busybox:1'), true);
  });

  it('does not match another tag or another image', () => {
    assert.equal(isSameImage('docker.io/molo17/x:2', 'molo17/x:1'), false);
    assert.equal(isSameImage('ghcr.io/molo17/x:1', 'molo17/x:1'), false);
  });
});
