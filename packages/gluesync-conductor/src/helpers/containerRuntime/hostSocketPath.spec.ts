import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type Docker from 'dockerode';

import {
  ENGINE_SOCKET_IN_CONTAINER,
  resetHostSocketPathCache,
  resolveHostSocketPath,
} from './hostSocketPath';

const saved = process.env.GS_CONTAINER_SOCKET;

beforeEach(() => {
  delete process.env.GS_CONTAINER_SOCKET;
  resetHostSocketPathCache();
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env.GS_CONTAINER_SOCKET;
  } else {
    process.env.GS_CONTAINER_SOCKET = saved;
  }
  resetHostSocketPathCache();
});

const dockerWith = (answer: unknown, inspected: string[] = []) =>
  ({
    getContainer: (id: string) => {
      inspected.push(id);
      return {
        inspect: async () => {
          if (answer instanceof Error) {
            throw answer;
          }
          return answer;
        },
      };
    },
  }) as unknown as Docker;

describe('resolveHostSocketPath', () => {
  it('takes GS_CONTAINER_SOCKET first, without asking the engine', async () => {
    process.env.GS_CONTAINER_SOCKET = ' /run/podman/podman.sock ';
    const inspected: string[] = [];

    assert.equal(
      await resolveHostSocketPath(dockerWith({}, inspected)),
      '/run/podman/podman.sock',
    );
    assert.deepEqual(inspected, []);
  });

  it('takes the source of the socket mount of its own container', async () => {
    const docker = dockerWith({
      Mounts: [
        { Destination: '/opt/gluesync/data', Source: '/srv/kit/shared' },
        {
          Destination: '/var/run/docker.sock',
          Source: '/run/user/1000/podman/podman.sock',
        },
      ],
    });

    assert.equal(
      await resolveHostSocketPath(docker),
      '/run/user/1000/podman/podman.sock',
    );
  });

  it('remembers the mount it found', async () => {
    const inspected: string[] = [];
    const docker = dockerWith(
      {
        Mounts: [
          {
            Destination: '/var/run/docker.sock',
            Source: '/run/podman/podman.sock',
          },
        ],
      },
      inspected,
    );

    await resolveHostSocketPath(docker);
    await resolveHostSocketPath(docker);

    assert.equal(inspected.length, 1);
  });

  it('falls back to /var/run/docker.sock without a socket mount', async () => {
    assert.equal(
      await resolveHostSocketPath(dockerWith({ Mounts: [] })),
      ENGINE_SOCKET_IN_CONTAINER,
    );
    assert.equal(
      await resolveHostSocketPath(dockerWith({})),
      ENGINE_SOCKET_IN_CONTAINER,
    );
  });

  it('falls back when this process is not a container the engine knows', async () => {
    const notFound = Object.assign(new Error('no such container'), {
      statusCode: 404,
    });

    assert.equal(
      await resolveHostSocketPath(dockerWith(notFound)),
      ENGINE_SOCKET_IN_CONTAINER,
    );
  });

  it('never throws when the engine cannot be asked', async () => {
    assert.equal(
      await resolveHostSocketPath(dockerWith(new Error('ECONNREFUSED'))),
      ENGINE_SOCKET_IN_CONTAINER,
    );
    assert.equal(
      await resolveHostSocketPath({} as unknown as Docker),
      ENGINE_SOCKET_IN_CONTAINER,
    );
  });

  it('does not wait for an engine socket that never answers', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const silent = {
        getContainer: () => ({
          inspect: () =>
            new Promise(() => {
              // never settles
            }),
        }),
      } as unknown as Docker;

      const pending = resolveHostSocketPath(silent);
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      mock.timers.tick(3000);

      assert.equal(await pending, ENGINE_SOCKET_IN_CONTAINER);
    } finally {
      mock.timers.reset();
    }
  });
});
