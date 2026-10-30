import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import fakeSwarmDocker from '../../../testing/fakeSwarmDocker';
import loadWithStubs from '../../../testing/loadWithStubs';
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

describe('resolveImageDigest on an engine without GET /distribution (Podman)', () => {
  const podmanError = Object.assign(new Error('unexpected - page not found'), {
    statusCode: 404,
  });

  const load = (hub: (image: string) => Promise<unknown>) => {
    const asked: string[] = [];
    const subject = loadWithStubs<{ default: typeof resolveImageDigest }>(
      path.resolve(__dirname, './resolveImageDigest'),
      {
        [path.resolve(__dirname, '../../dockerHubRegistry/dockerHubManifest')]:
          {
            dockerHubManifest: async (image: string) => {
              asked.push(image);
              return hub(image);
            },
            isDistributionUnavailable: (error: { statusCode?: number }) =>
              error.statusCode === 404 || error.statusCode === 501,
          },
      },
    );
    return { resolve: subject.default, asked };
  };

  it('pins the tag to the digest Docker Hub has for it', async () => {
    const { resolve, asked } = load(async () => ({ digest: 'sha256:fed' }));
    const { docker } = fakeSwarmDocker({ distributionError: podmanError });

    assert.equal(
      await resolve(docker, 'molo17/hub:2'),
      'molo17/hub:2@sha256:fed',
    );
    assert.deepEqual(asked, ['molo17/hub:2']);
  });

  it('keeps the tag when Docker Hub does not know the image or cannot be asked', async () => {
    const { docker } = fakeSwarmDocker({ distributionError: podmanError });

    assert.equal(
      await load(async () => undefined).resolve(docker, 'molo17/hub:2'),
      'molo17/hub:2',
    );
    assert.equal(
      await load(async () => {
        throw new Error('ECONNREFUSED');
      }).resolve(docker, 'molo17/hub:2'),
      'molo17/hub:2',
    );
  });

  it('does not ask Docker Hub for any other registry error', async () => {
    const { resolve, asked } = load(async () => ({ digest: 'sha256:fed' }));
    const { docker } = fakeSwarmDocker();

    assert.equal(await resolve(docker, 'molo17/local:dev'), 'molo17/local:dev');
    assert.deepEqual(asked, []);
  });
});
