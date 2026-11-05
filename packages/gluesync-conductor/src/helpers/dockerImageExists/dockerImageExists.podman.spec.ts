import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';

const here = (p: string): string => path.resolve(__dirname, p);

type Subject = { default: typeof import('./dockerImageExists').default };

const podmanError = Object.assign(new Error('unexpected - page not found'), {
  statusCode: 404,
});
const fail = (error: Error) => async () => {
  throw error;
};

const load = (hub: (image: string) => Promise<unknown>) => {
  const asked: string[] = [];
  const subject = loadWithStubs<Subject>(here('./dockerImageExists'), {
    [here('../dockerHubRegistry/dockerHubManifest')]: {
      dockerHubManifest: async (image: string) => {
        asked.push(image);
        return hub(image);
      },
      isDistributionUnavailable: (error: { statusCode?: number }) =>
        error.statusCode === 404 || error.statusCode === 501,
    },
  });
  return { exists: subject.default, asked };
};

const docker = (distribution: () => Promise<unknown>) =>
  ({
    getImage: () => ({
      inspect: fail(new Error('no such image')),
      distribution,
    }),
  }) as never;

describe('dockerImageExists on an engine without GET /distribution', () => {
  it('asks Docker Hub when the engine answers 404, and finds the image there', async () => {
    const { exists, asked } = load(async () => ({ digest: 'sha256:abc' }));

    assert.equal(
      await exists('molo17/gluesync-chronos:0.3.2-debian', {
        docker: docker(fail(podmanError)),
      }),
      true,
    );
    assert.deepEqual(asked, ['molo17/gluesync-chronos:0.3.2-debian']);
  });

  it('asks Docker Hub when the engine answers 501', async () => {
    const { exists, asked } = load(async () => ({ digest: 'sha256:abc' }));

    assert.equal(
      await exists('molo17/x:1', {
        docker: docker(
          fail(Object.assign(new Error('nope'), { statusCode: 501 })),
        ),
      }),
      true,
    );
    assert.equal(asked.length, 1);
  });

  it('is false when Docker Hub has no such tag', async () => {
    const { exists } = load(async () => undefined);

    assert.equal(
      await exists('molo17/gluesync-chronos:0.3.1-debian', {
        docker: docker(fail(podmanError)),
      }),
      false,
    );
  });

  it('is false when Docker Hub cannot be reached', async () => {
    const { exists } = load(async () => {
      throw new Error('ECONNREFUSED');
    });

    assert.equal(
      await exists('molo17/x:1', { docker: docker(fail(podmanError)) }),
      false,
    );
  });

  it('does not ask Docker Hub when the engine knows its registry', async () => {
    const { exists, asked } = load(async () => ({ digest: 'sha256:abc' }));

    assert.equal(
      await exists('molo17/x:1', { docker: docker(async () => ({})) }),
      true,
    );
    assert.equal(
      await exists('molo17/x:9', {
        docker: docker(
          fail(Object.assign(new Error('401'), { statusCode: 401 })),
        ),
      }),
      false,
    );
    assert.deepEqual(asked, []);
  });

  it('does not ask Docker Hub when the image is present locally', async () => {
    const { exists, asked } = load(async () => ({ digest: 'sha256:abc' }));
    const local = {
      getImage: () => ({
        inspect: async () => ({}),
        distribution: fail(podmanError),
      }),
    } as never;

    assert.equal(await exists('molo17/x:1', { docker: local }), true);
    assert.deepEqual(asked, []);
  });
});
