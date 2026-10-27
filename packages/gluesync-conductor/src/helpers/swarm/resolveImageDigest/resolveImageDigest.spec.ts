import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeSwarmDocker from '../../../testing/fakeSwarmDocker';
import resolveImageDigest from './resolveImageDigest';

describe('resolveImageDigest', () => {
  it('pins the tag to the digest its registry has for it', async () => {
    const { docker, calls } = fakeSwarmDocker({
      digests: { 'molo17/hub:2': 'sha256:abc' },
    });

    assert.equal(
      await resolveImageDigest(docker, 'molo17/hub:2'),
      'molo17/hub:2@sha256:abc',
    );
    assert.deepEqual(calls.distributions, ['molo17/hub:2']);
  });

  it('keeps an image that already names its digest', async () => {
    const { docker, calls } = fakeSwarmDocker();

    assert.equal(
      await resolveImageDigest(docker, 'molo17/hub:2@sha256:abc'),
      'molo17/hub:2@sha256:abc',
    );
    assert.deepEqual(calls.distributions, []);
  });

  it('keeps the tag when the registry does not know the image, like the CLI', async () => {
    const { docker } = fakeSwarmDocker();

    assert.equal(
      await resolveImageDigest(docker, 'molo17/local-build:dev'),
      'molo17/local-build:dev',
    );
  });

  it('gives a dropped Docker API back to the caller to retry', async () => {
    const { docker } = fakeSwarmDocker({
      distributionError: Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    });

    await assert.rejects(resolveImageDigest(docker, 'molo17/hub:2'), {
      code: 'ECONNREFUSED',
    });
  });
});
