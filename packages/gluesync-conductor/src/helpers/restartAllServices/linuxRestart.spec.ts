import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import { resetHostSocketPathCache } from '../containerRuntime/hostSocketPath';

const here = (p: string): string => path.resolve(__dirname, p);

type Mount = Readonly<{ Destination: string; Source: string }>;

const load = (mounts: ReadonlyArray<Mount> = []) => {
  resetHostSocketPathCache();
  const spawned: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
  const restart = loadWithStubs<{
    default: (options: {
      hostProjectDir: string;
      helperImage?: string;
    }) => Promise<boolean>;
  }>(here('./linuxRestart'), {
    [here('../autoReboot/autoReboot')]: {
      spawnAsync: async (cmd: string, args: ReadonlyArray<string>) => {
        spawned.push({ cmd, args });
        return true;
      },
    },
    [here('../../utils/logger')]: {
      getLogger: () => ({ info: () => 0 }),
    },
    [here('../../utils/docker/getDocker')]: {
      getDocker: () => ({
        getContainer: () => ({ inspect: async () => ({ Mounts: mounts }) }),
      }),
    },
  }).default;
  return { restart, spawned };
};

const helperRun = (spawned: ReadonlyArray<{ args: ReadonlyArray<string> }>) =>
  spawned.find(({ args }) => args[0] === 'run')?.args ?? [];

describe('restartLinux', () => {
  it('requires the host project directory', async () => {
    const { restart, spawned } = load();

    await assert.rejects(
      restart({ hostProjectDir: '' }),
      /hostProjectDir is required/,
    );
    assert.equal(spawned.length, 0);
  });

  it('runs the whole-stack restart in a fully qualified helper image', async () => {
    const { restart, spawned } = load();

    assert.equal(await restart({ hostProjectDir: '/srv/gs' }), true);

    const args = helperRun(spawned);
    assert.deepEqual(args.slice(0, 9), [
      'run',
      '--rm',
      '--security-opt',
      'label=disable',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      '/srv/gs:/srv/gs',
      '-w',
    ]);
    assert.equal(args[9], '/srv/gs');
    assert.equal(args[10], 'docker.io/library/docker:28');
    assert.match(args[args.length - 1], /docker compose pull/);
  });

  it('mounts the host path of the socket this container runs on (Podman rootful)', async () => {
    const { restart, spawned } = load([
      {
        Destination: '/var/run/docker.sock',
        Source: '/run/podman/podman.sock',
      },
    ]);

    await restart({ hostProjectDir: '/srv/gs' });

    const args = helperRun(spawned);
    assert.equal(
      args[args.indexOf('-v') + 1],
      '/run/podman/podman.sock:/var/run/docker.sock',
    );
    // the helper's compose reads the kit .env; without one it is told the socket
    assert.ok(args.includes('GS_CONTAINER_SOCKET=/run/podman/podman.sock'));
  });

  it('keeps a helper image the caller chose', async () => {
    const { restart, spawned } = load();

    await restart({
      hostProjectDir: '/srv/gs',
      helperImage: 'mirror/docker:28',
    });

    assert.ok(helperRun(spawned).includes('mirror/docker:28'));
  });
});
