import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import dockerImageExists from './dockerImageExists';

type Lookups = Readonly<{
  inspect: () => Promise<unknown>;
  distribution: () => Promise<unknown>;
}>;

const fakeDocker = (lookups: Lookups, asked: string[] = []) =>
  ({
    getImage: (name: string) => {
      asked.push(name);
      return lookups;
    },
  }) as never;

const ok = async () => ({});
const fail = async () => {
  throw new Error('nope');
};

describe('dockerImageExists', () => {
  it('is true when the image is present locally, without asking the registry', async () => {
    let registryAsked = false;
    const result = await dockerImageExists(
      'molo17/gluesync-chronos:0.3.2-debian',
      {
        docker: fakeDocker({
          inspect: ok,
          distribution: async () => {
            registryAsked = true;
          },
        }),
      },
    );

    assert.equal(result, true);
    assert.equal(registryAsked, false);
  });

  it('falls back to the registry lookup through the daemon', async () => {
    const asked: string[] = [];
    const result = await dockerImageExists(
      'molo17/gluesync-chronos:0.3.2-debian',
      {
        docker: fakeDocker({ inspect: fail, distribution: ok }, asked),
      },
    );

    assert.equal(result, true);
    assert.deepEqual(asked, [
      'molo17/gluesync-chronos:0.3.2-debian',
      'molo17/gluesync-chronos:0.3.2-debian',
    ]);
  });

  it('is false when neither the daemon nor the registry know the image', async () => {
    assert.equal(
      await dockerImageExists('molo17/gluesync-chronos:0.3.1-debian', {
        docker: fakeDocker({ inspect: fail, distribution: fail }),
      }),
      false,
    );
  });

  it('is false when the lookup does not answer in time', async () => {
    assert.equal(
      await dockerImageExists('molo17/gluesync-chronos:0.3.2-debian', {
        docker: fakeDocker({
          inspect: fail,
          distribution: () =>
            new Promise(() => {
              // never settles
            }),
        }),
        timeoutMs: 20,
      }),
      false,
    );
  });
});
