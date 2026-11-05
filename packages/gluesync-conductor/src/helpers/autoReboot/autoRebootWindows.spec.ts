import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  const logged: string[] = [];
  const autoRebootWindows = loadWithStubs<{
    default: (options: {
      hostProjectDir: string;
      serviceName: string;
      helperImage: string;
    }) => Promise<boolean>;
  }>(here('./autoRebootWindows'), {
    [here('./autoReboot')]: {
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
    [here('../../utils/logger')]: {
      getLogger: () => ({
        info: (message: unknown) => logged.push(String(message)),
      }),
    },
  }).default;
  return { autoRebootWindows, spawned, logged };
};

const run = async (spawnResult?: Error) => {
  process.env.BASE_PATH = 'E:/Gluesync';
  const loaded = load(spawnResult);
  const kit = mkdtempSync(path.join(tmpdir(), 'kit-'));
  writeFileSync(path.join(kit, '.env'), 'A=1');
  const result = await loaded.autoRebootWindows({
    hostProjectDir: kit,
    serviceName: 'gluesync-conductor',
    helperImage: 'helper:win',
  });
  return { ...loaded, result, kit };
};

describe('autoRebootWindows', () => {
  it('requires the host project directory', async () => {
    const { autoRebootWindows, spawned } = load();

    await assert.rejects(
      autoRebootWindows({
        hostProjectDir: '',
        serviceName: 'gluesync-conductor',
        helperImage: 'helper:win',
      }),
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
    assert.match(name, /^gluesync-conductor-updater-\d+$/);
    // the options come before the image
    assert.ok(args.indexOf('-d') < args.indexOf('helper:win'));
    assert.ok(args.indexOf('--name') < args.indexOf('helper:win'));
  });

  it('keeps update mode on: starting the helper is not the end of the update', async () => {
    const { spawned } = await run();

    assert.deepEqual(spawned[0]?.opts, { keepUpdateMode: true });
  });

  it('pulls then recreates the service, logging each step to the kit folder', async () => {
    const { spawned } = await run();
    const args = spawned[0]?.args ?? [];
    const name = args[args.indexOf('--name') + 1] as string;
    const script = args.at(-1) as string;

    assert.ok(script.indexOf(' pull gluesync-conductor') > 0);
    assert.ok(
      script.indexOf(' pull gluesync-conductor') <
        script.indexOf('up -d --force-recreate gluesync-conductor'),
    );
    assert.ok(script.includes('--env-file "C:/update_context/.env"'));
    assert.ok(
      script.includes(
        `$log='C:/update_context/.conductor/helper-logs/${name}.log'`,
      ),
    );
    assert.ok(script.includes('New-Item -ItemType Directory -Force'));
    assert.ok(script.includes("Log ('recreate exit code ' + $LASTEXITCODE)"));
  });

  it('logs the helper name once it is started', async () => {
    const { logged, spawned } = await run();
    const name = spawned[0]?.args[spawned[0].args.indexOf('--name') + 1];

    assert.ok(
      logged.some(
        line => line.includes('started detached') && line.includes(`${name}`),
      ),
    );
  });

  it('rejects when the helper cannot be started', async () => {
    await assert.rejects(run(new Error('no such image')), /no such image/);
  });
});
