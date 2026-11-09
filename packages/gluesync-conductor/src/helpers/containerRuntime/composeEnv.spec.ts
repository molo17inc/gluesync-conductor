import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import loadWithStubs from '../../testing/loadWithStubs';
import { resetHostSocketPathCache } from './hostSocketPath';

const here = (p: string): string => path.resolve(__dirname, p);

type Subject = typeof import('./composeEnv');

const saved = {
  socket: process.env.GS_CONTAINER_SOCKET,
  windows: process.env.IS_WINDOWS,
  cwd: process.env.PROJECT_CWD,
};

beforeEach(() => {
  delete process.env.GS_CONTAINER_SOCKET;
  delete process.env.IS_WINDOWS;
  delete process.env.PROJECT_CWD;
  resetHostSocketPathCache();
});

afterEach(() => {
  Object.entries({
    GS_CONTAINER_SOCKET: saved.socket,
    IS_WINDOWS: saved.windows,
    PROJECT_CWD: saved.cwd,
  }).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  resetHostSocketPathCache();
});

// A kit directory with the given `.env` text (none when undefined). It stands in
// for /opt/gluesync-conductor/root-folder: PROJECT_CWD points at it.
const kit = (envText?: string): Subject => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-'));
  mkdirSync(dir, { recursive: true });
  if (envText !== undefined) {
    writeFileSync(path.join(dir, '.env'), envText);
  }
  process.env.PROJECT_CWD = dir;
  // existsSync of the fixed container path is false on a dev machine and in CI
  return loadWithStubs<Subject>(here('./composeEnv'), {});
};

const dockerMounting = (source?: string) =>
  ({
    getContainer: () => ({
      inspect: async () => ({
        Mounts: source
          ? [{ Destination: '/var/run/docker.sock', Source: source }]
          : [],
      }),
    }),
  }) as unknown as Docker;

describe('kitEnvFilePath / composeEnvFileOptions', () => {
  it('finds the .env of the kit directory and passes it as --env-file', () => {
    const subject = kit('GS_COREHUB_USERNS=keep-id:uid=1017,gid=1017\n');

    assert.equal(
      subject.kitEnvFilePath(),
      path.join(process.env.PROJECT_CWD as string, '.env'),
    );
    assert.deepEqual(subject.composeEnvFileOptions(), [
      '--env-file',
      path.join(process.env.PROJECT_CWD as string, '.env'),
    ]);
  });

  it('passes nothing when there is no .env', () => {
    const subject = kit();

    assert.equal(subject.kitEnvFilePath(), undefined);
    assert.deepEqual(subject.composeEnvFileOptions(), []);
  });

  it('leaves Windows containers alone', () => {
    const subject = kit('A=1\n');
    process.env.IS_WINDOWS = 'true';

    assert.deepEqual(subject.composeEnvFileOptions(), []);
  });
});

describe('readKitEnv', () => {
  it('reads the keys of the .env', () => {
    const subject = kit(
      'GS_CONTAINER_SOCKET=/run/podman/podman.sock\nX="a b"\n',
    );

    assert.deepEqual(subject.readKitEnv(), {
      GS_CONTAINER_SOCKET: '/run/podman/podman.sock',
      X: 'a b',
    });
  });

  it('is empty without a .env', () => {
    assert.deepEqual(kit().readKitEnv(), {});
  });
});

describe('composeChildEnv', () => {
  it('adds the socket this container runs on when no .env has it', async () => {
    const subject = kit('OTHER=1\n');
    const env = await subject.composeChildEnv(
      dockerMounting('/run/user/1000/podman/podman.sock'),
    );

    assert.equal(env?.GS_CONTAINER_SOCKET, '/run/user/1000/podman/podman.sock');
    assert.equal(env?.PATH, process.env.PATH);
  });

  it('adds nothing when the kit .env has the socket', async () => {
    const subject = kit('GS_CONTAINER_SOCKET=/run/podman/podman.sock\n');

    assert.equal(
      await subject.composeChildEnv(dockerMounting('/run/other.sock')),
      undefined,
    );
  });

  it('adds nothing when the environment has the socket', async () => {
    const subject = kit();
    process.env.GS_CONTAINER_SOCKET = '/run/podman/podman.sock';

    assert.equal(await subject.composeChildEnv(dockerMounting()), undefined);
  });

  it('adds nothing on Docker, whose socket is the compose default', async () => {
    const subject = kit();

    assert.equal(
      await subject.composeChildEnv(dockerMounting('/var/run/docker.sock')),
      undefined,
    );
    assert.equal(await subject.composeChildEnv(dockerMounting()), undefined);
  });
});

describe('helperSocketEnvArgs', () => {
  it('gives the helper the socket when its .env has none', async () => {
    const subject = kit();

    assert.deepEqual(
      await subject.helperSocketEnvArgs(
        dockerMounting('/run/podman/podman.sock'),
      ),
      ['-e', 'GS_CONTAINER_SOCKET=/run/podman/podman.sock'],
    );
  });

  it('leaves it to the .env the helper reads when that has the socket', async () => {
    const subject = kit('GS_CONTAINER_SOCKET=/run/podman/podman.sock\n');

    assert.deepEqual(
      await subject.helperSocketEnvArgs(dockerMounting('/run/other.sock')),
      [],
    );
  });

  it('gives nothing on Docker', async () => {
    const subject = kit();

    assert.deepEqual(await subject.helperSocketEnvArgs(dockerMounting()), []);
  });
});
