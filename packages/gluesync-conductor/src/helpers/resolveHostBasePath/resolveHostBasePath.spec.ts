import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import loadWithStubs from '../../testing/loadWithStubs';

const here = (p: string): string => path.resolve(__dirname, p);

const saved = process.env.BASE_PATH;

beforeEach(() => {
  delete process.env.BASE_PATH;
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env.BASE_PATH;
  } else {
    process.env.BASE_PATH = saved;
  }
});

type Inspect = Readonly<{
  Config?: { Labels?: Record<string, string> };
  Mounts?: ReadonlyArray<{ Source: string; Destination: string }>;
}>;

const load = (inspect: () => Promise<Inspect | undefined>) => {
  const logs: string[] = [];
  const log =
    (level: string) =>
    (...args: unknown[]) => {
      logs.push(
        `${level}: ${args.filter(a => typeof a === 'string').join(' ')}`,
      );
    };
  const resolve = loadWithStubs<{
    default: (docker: Docker) => Promise<void>;
  }>(here('./resolveHostBasePath'), {
    [here('../../utils/logger')]: {
      getLogger: () => ({ info: log('info'), warn: log('warn') }),
    },
    [here('../orchestrator/getOrchestrator/getOrchestrator')]: {
      inspectSelf: inspect,
    },
  }).default;

  return { run: () => resolve({} as Docker), logs };
};

const WORKING_DIR = 'com.docker.compose.project.working_dir';

describe('resolveHostBasePath', () => {
  it('leaves an absolute posix BASE_PATH untouched', async () => {
    process.env.BASE_PATH = '/srv/gluesync';
    const { run, logs } = load(async () => ({
      Config: { Labels: { [WORKING_DIR]: '/other' } },
    }));

    await run();

    assert.equal(process.env.BASE_PATH, '/srv/gluesync');
    assert.deepEqual(logs, []);
  });

  const untouchedWindows = (value: string) => async () => {
    process.env.BASE_PATH = value;
    const { run } = load(async () => ({
      Config: { Labels: { [WORKING_DIR]: '/other' } },
    }));

    await run();

    assert.equal(process.env.BASE_PATH, value);
  };

  it(
    'leaves an absolute Windows BASE_PATH untouched',
    untouchedWindows(String.raw`C:\Program Files\Gluesync`),
  );

  it(
    'leaves an absolute Windows BASE_PATH with forward slashes untouched',
    untouchedWindows('C:/Program Files/Gluesync'),
  );

  it('replaces "." with the working_dir label', async () => {
    process.env.BASE_PATH = '.';
    const { run, logs } = load(async () => ({
      Config: { Labels: { [WORKING_DIR]: String.raw`C:\Kits\gluesync` } },
    }));

    await run();

    assert.equal(process.env.BASE_PATH, String.raw`C:\Kits\gluesync`);
    assert.deepEqual(logs, [
      String.raw`info: [base-path] BASE_PATH "." is not an absolute host path; using C:\Kits\gluesync from the conductor container`,
    ]);
  });

  it('replaces an empty or unset BASE_PATH', async () => {
    const inspect = async () => ({
      Config: { Labels: { [WORKING_DIR]: '/home/me/kit' } },
    });

    process.env.BASE_PATH = '';
    await load(inspect).run();
    assert.equal(process.env.BASE_PATH, '/home/me/kit');

    delete process.env.BASE_PATH;
    await load(inspect).run();
    assert.equal(process.env.BASE_PATH, '/home/me/kit');
  });

  it('falls back to the kit directory mount on Linux', async () => {
    process.env.BASE_PATH = '.';
    const { run } = load(async () => ({
      Config: { Labels: {} },
      Mounts: [
        { Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
        {
          Source: '/home/me/kit',
          Destination: '/opt/gluesync-conductor/root-folder',
        },
      ],
    }));

    await run();

    assert.equal(process.env.BASE_PATH, '/home/me/kit');
  });

  it('falls back to the kit directory mount on Windows', async () => {
    process.env.BASE_PATH = '.';
    const { run } = load(async () => ({
      Mounts: [
        {
          Source: String.raw`C:\Kits\gluesync`,
          Destination: String.raw`c:\opt\gluesync-conductor\root-folder\\`,
        },
      ],
    }));

    await run();

    assert.equal(process.env.BASE_PATH, String.raw`C:\Kits\gluesync`);
  });

  it('warns and changes nothing when nothing is found', async () => {
    process.env.BASE_PATH = '.';
    const { run, logs } = load(async () => ({
      Config: { Labels: {} },
      Mounts: [{ Source: '/a', Destination: '/b' }],
    }));

    await run();

    assert.equal(process.env.BASE_PATH, '.');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^warn: \[base-path\]/);
  });

  it('warns and changes nothing when the container is unknown', async () => {
    process.env.BASE_PATH = '.';
    const { run, logs } = load(async () => undefined);

    await run();

    assert.equal(process.env.BASE_PATH, '.');
    assert.match(logs[0], /^warn:/);
  });

  it('does not throw when the inspect fails', async () => {
    process.env.BASE_PATH = '.';
    const { run, logs } = load(async () => {
      throw new Error('daemon down');
    });

    await run();

    assert.equal(process.env.BASE_PATH, '.');
    assert.match(logs[0], /^warn:/);
  });
});
