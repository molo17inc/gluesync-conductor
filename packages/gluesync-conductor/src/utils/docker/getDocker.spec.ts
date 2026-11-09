import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';

const here = (p: string): string => path.resolve(__dirname, p);

type Subject = typeof import('./getDocker');

const KEYS = ['DOCKER_HOST', 'CONTAINER_HOST', 'XDG_RUNTIME_DIR'] as const;
const saved = KEYS.map(key => [key, process.env[key]] as const);

beforeEach(() => {
  KEYS.forEach(key => {
    delete process.env[key];
  });
});

afterEach(() => {
  saved.forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
});

// getDocker, loaded on `platform` with `existing` sockets on disk
const load = (platform: string, existing: ReadonlyArray<string> = []) => {
  const built: unknown[] = [];
  // eslint-disable-next-line functional/no-classes -- dockerode is built with `new`
  class FakeDocker {
    constructor(options?: unknown) {
      // eslint-disable-next-line functional/immutable-data -- spy
      built.push(options);
    }
  }
  const subject = loadWithStubs<Subject>(here('./getDocker'), {
    dockerode: { default: FakeDocker },
    os: { default: { platform: () => platform, homedir: () => '/home/u' } },
    fs: { default: { existsSync: (p: string) => existing.includes(p) } },
    [here('../logger')]: {
      getLogger: () => ({ info: () => 0, warn: () => 0 }),
    },
  });
  return { subject, built };
};

// The options the Docker client was built with
const clientOptions = (
  platform: string,
  existing: ReadonlyArray<string> = [],
): unknown => load(platform, existing).built[0];

describe('getDocker on Linux', () => {
  it('uses the Docker socket when there is one', () => {
    assert.deepEqual(
      clientOptions('linux', [
        '/var/run/docker.sock',
        '/run/podman/podman.sock',
      ]),
      { socketPath: '/var/run/docker.sock' },
    );
  });

  it('probes the rootful Podman socket', () => {
    assert.deepEqual(clientOptions('linux', ['/run/podman/podman.sock']), {
      socketPath: '/run/podman/podman.sock',
    });
  });

  it('probes the rootless Podman socket under XDG_RUNTIME_DIR', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';

    assert.deepEqual(
      clientOptions('linux', ['/run/user/1000/podman/podman.sock']),
      { socketPath: '/run/user/1000/podman/podman.sock' },
    );
  });

  it('falls back to the default client when no socket exists', () => {
    assert.equal(clientOptions('linux', []), undefined);
  });

  it('honours CONTAINER_HOST before probing', () => {
    process.env.CONTAINER_HOST = 'unix:///run/user/1000/podman/podman.sock';

    assert.deepEqual(clientOptions('linux', ['/var/run/docker.sock']), {
      socketPath: '/run/user/1000/podman/podman.sock',
    });
  });

  it('lets DOCKER_HOST win over CONTAINER_HOST', () => {
    process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
    process.env.CONTAINER_HOST = 'unix:///run/podman/podman.sock';

    assert.equal(clientOptions('linux', []), undefined);
  });

  it('ignores a CONTAINER_HOST it cannot talk to and probes instead', () => {
    process.env.CONTAINER_HOST = 'ssh://core@host/run/podman/podman.sock';

    assert.deepEqual(clientOptions('linux', ['/run/podman/podman.sock']), {
      socketPath: '/run/podman/podman.sock',
    });
  });
});

describe('dockerOptionsFromContainerHost', () => {
  const { dockerOptionsFromContainerHost } = load('linux').subject;

  it('reads unix sockets and bare paths', () => {
    assert.deepEqual(
      dockerOptionsFromContainerHost('unix:///run/podman/podman.sock'),
      {
        socketPath: '/run/podman/podman.sock',
      },
    );
    assert.deepEqual(
      dockerOptionsFromContainerHost('/run/podman/podman.sock'),
      {
        socketPath: '/run/podman/podman.sock',
      },
    );
  });

  it('reads tcp and http addresses', () => {
    assert.deepEqual(dockerOptionsFromContainerHost('tcp://10.0.0.5:2375'), {
      host: '10.0.0.5',
      port: 2375,
      protocol: 'http',
    });
    assert.deepEqual(dockerOptionsFromContainerHost('https://engine'), {
      host: 'engine',
      port: 2376,
      protocol: 'https',
    });
  });

  it('gives up on ssh', () => {
    assert.equal(
      dockerOptionsFromContainerHost('ssh://u@h/run/x.sock'),
      undefined,
    );
  });
});
