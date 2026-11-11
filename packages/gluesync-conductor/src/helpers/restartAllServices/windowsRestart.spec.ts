import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';

const here = (p: string): string => path.resolve(__dirname, p);

type Spawn = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
  opts?: Readonly<{ keepUpdateMode?: boolean }>;
}>;

const originalBasePath = process.env.BASE_PATH;

afterEach(() => {
  if (originalBasePath === undefined) {
    delete process.env.BASE_PATH;
  } else {
    process.env.BASE_PATH = originalBasePath;
  }
});

const load = (spawnResult: Error | undefined = undefined) => {
  const spawned: Spawn[] = [];
  const restart = loadWithStubs<{
    default: (options: {
      hostProjectDir: string;
      helperImage: string;
    }) => Promise<boolean>;
  }>(here('./windowsRestart'), {
    [here('../autoReboot/autoReboot')]: {
      spawnAsync: async (
        cmd: string,
        args: ReadonlyArray<string>,
        opts?: Spawn['opts'],
      ) => {
        spawned.push({ cmd, args, opts });
        if (spawnResult) {
          throw spawnResult;
        }
        return true;
      },
    },
  }).default;
  return { restart, spawned };
};

const run = async (spawnResult?: Error) => {
  process.env.BASE_PATH = 'E:/Gluesync';
  const loaded = load(spawnResult);
  const result = await loaded.restart({
    hostProjectDir: 'E:\\Gluesync\\',
    helperImage: 'helper:win',
  });
  return { ...loaded, result };
};

describe('restartWindows', () => {
  it('requires the host project directory', async () => {
    const { restart, spawned } = load();

    await assert.rejects(
      restart({ hostProjectDir: '', helperImage: 'helper:win' }),
      /hostProjectDir is required/,
    );
    assert.equal(spawned.length, 0);
  });

  it('starts the helper detached, removed on exit and with a recognisable name', async () => {
    const { result, spawned } = await run();

    assert.equal(result, true);
    assert.equal(spawned.length, 1);
    const { cmd, args } = spawned[0] as Spawn;
    assert.equal(cmd, 'docker');
    assert.equal(args[0], 'run');
    assert.ok(args.includes('-d'));
    assert.ok(args.includes('--rm'));
    assert.ok(!args.includes('--sig-proxy=false'));
    const name = args[args.indexOf('--name') + 1] as string;
    assert.match(name, /^gluesync-restart-helper-\d+$/);
    assert.ok(args.indexOf('-d') < args.indexOf('helper:win'));
    assert.ok(args.indexOf('--name') < args.indexOf('helper:win'));
    // A second restart request finds it by this label
    assert.equal(
      args[args.indexOf('--label') + 1],
      'com.molo17.conductor.helper=full-stack-restart',
    );
    assert.ok(args.indexOf('--label') < args.indexOf('helper:win'));
    assert.ok(args.includes('E:/Gluesync:C:/update_context'));
  });

  it('keeps update mode on: starting the helper is not the end of the restart', async () => {
    const { spawned } = await run();

    assert.deepEqual(spawned[0]?.opts, { keepUpdateMode: true });
  });

  it('takes the stack down and brings it up without pulling, logging each step to the kit folder', async () => {
    const { spawned } = await run();
    const args = spawned[0]?.args ?? [];
    const name = args[args.indexOf('--name') + 1] as string;
    const script = args.at(-1) as string;

    const down = script.indexOf('down --remove-orphans');
    const up = script.indexOf('--project-directory "E:/Gluesync" up -d');
    assert.ok(down > 0 && down < up);
    // A restart never updates the images it brings back
    assert.ok(!script.includes(' pull'));
    assert.ok(
      script.includes(
        `$log='C:/update_context/.conductor/helper-logs/${name}.log'`,
      ),
    );
    assert.ok(script.includes("Log ('up exit code ' + $LASTEXITCODE)"));
  });

  it('sets BASE_PATH to the host path, never to the helper mount point', async () => {
    const { spawned } = await run();
    const script = spawned[0]?.args.at(-1) as string;

    // compose copies it into the recreated conductor, whose BASE_PATH must be
    // the host project directory (normalised: forward slashes, no trailing one)
    assert.ok(
      script.startsWith(
        "$env:DOCKER_HOST='npipe:////./pipe/docker_engine'; $env:BASE_PATH='E:/Gluesync'; ",
      ),
    );
    assert.ok(!script.includes("$env:BASE_PATH='C:/update_context'"));
    assert.equal(script.match(/\$env:BASE_PATH='[^']*'/g)?.length, 1);
  });

  it('rejects when the helper cannot be started', async () => {
    await assert.rejects(run(new Error('no such image')), /no such image/);
  });
});
