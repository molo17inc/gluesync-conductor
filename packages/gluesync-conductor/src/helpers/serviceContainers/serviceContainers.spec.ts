import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Docker from 'dockerode';

import { observeService } from './serviceContainers';

const docker = (image: string, state = 'running') =>
  ({
    listContainers: async () => [
      { Id: 'abc', State: state, Created: 1, ImageID: 'sha256:1' },
    ],
    getContainer: () => ({
      inspect: async () => ({
        State: {
          Running: state === 'running',
          Restarting: false,
          Status: state,
        },
        Config: { Image: image },
      }),
    }),
  }) as unknown as Docker;

describe('observeService', () => {
  it('reports the image as the compose file names it, whatever the engine says', async () => {
    assert.equal(
      (await observeService(docker('molo17/x:1'), 'x')).image,
      'molo17/x:1',
    );
    assert.equal(
      (await observeService(docker('docker.io/molo17/x:1'), 'x')).image,
      'molo17/x:1',
    );
    assert.equal(
      (await observeService(docker('docker.io/library/busybox:1.36'), 'b'))
        .image,
      'busybox:1.36',
    );
  });

  it('says whether the container runs', async () => {
    const seen = await observeService(docker('molo17/x:1', 'exited'), 'x');

    assert.equal(seen.running, false);
    assert.equal(seen.detail, 'exited');
  });
});
