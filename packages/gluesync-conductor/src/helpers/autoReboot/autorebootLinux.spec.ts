import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';

const here = (p: string): string => path.resolve(__dirname, p);

type Options = Readonly<{
  hostProjectDir: string;
  serviceName: string;
  helperImage: string;
  rollbackImage?: string;
}>;

type Compose = { services?: Record<string, { image?: string }> };

const load = (compose: Compose | Error) => {
  const spawned: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
  const logged: unknown[][] = [];
  const reads: unknown[] = [];
  const autoRebootLinux = loadWithStubs<{
    default: (options: Partial<Options>) => Promise<boolean>;
  }>(here('./autorebootLinux'), {
    [here('./autoReboot')]: {
      spawnAsync: async (cmd: string, args: ReadonlyArray<string>) => {
        spawned.push({ cmd, args });
        return true;
      },
    },
    [here('../composeFile/readComposeFile/readComposeFile')]: {
      readComposeFile: async (options: unknown) => {
        reads.push(options);
        if (compose instanceof Error) {
          throw compose;
        }
        return compose;
      },
    },
    [here('../../utils/logger')]: {
      getLogger: () => ({
        info: (...args: unknown[]) => logged.push(args),
      }),
    },
  }).default;
  return { autoRebootLinux, spawned, logged, reads };
};

const envOf = (args: ReadonlyArray<string>): Record<string, string> =>
  Object.fromEntries(
    args
      .map((arg, i) => (args[i - 1] === '-e' ? arg : undefined))
      .filter((arg): arg is string => arg !== undefined)
      .map(arg => [
        arg.slice(0, arg.indexOf('=')),
        arg.slice(arg.indexOf('=') + 1),
      ]),
  );

const compose: Compose = {
  services: { 'gluesync-conductor': { image: 'conductor:2' } },
};

describe('autoRebootLinux', () => {
  it('requires the host project directory', async () => {
    const { autoRebootLinux, spawned } = load(compose);
    await assert.rejects(
      autoRebootLinux({ hostProjectDir: '' }),
      /hostProjectDir is required/,
    );
    assert.equal(spawned.length, 0);
  });

  it('recreates the service without rollback by default', async () => {
    const { autoRebootLinux, spawned, reads } = load(compose);
    assert.equal(await autoRebootLinux({ hostProjectDir: '/srv/gs' }), true);
    assert.equal(reads.length, 0);
    assert.equal(spawned.length, 1);
    const { cmd, args } = spawned[0];
    assert.equal(cmd, 'docker');
    assert.deepEqual(args.slice(0, 7), [
      'run',
      '--rm',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      '/srv/gs:/srv/gs',
      '-w',
    ]);
    assert.deepEqual(envOf(args), {
      SVC: 'gluesync-conductor',
      NEW_IMAGE: '',
      ROLLBACK_IMAGE: '',
    });
    assert.deepEqual(args.slice(-4, -2), ['docker:28', 'sh']);
    assert.match(
      args[args.length - 1],
      /docker compose up -d --force-recreate/,
    );
  });

  it('passes the new and the previous image when a rollback is possible', async () => {
    const { autoRebootLinux, spawned, reads, logged } = load(compose);
    await autoRebootLinux({
      hostProjectDir: '/srv/gs',
      serviceName: 'gluesync-conductor',
      helperImage: 'docker:27',
      rollbackImage: 'conductor:1',
    });
    assert.deepEqual(reads, [{ raw: true }]);
    const { args } = spawned[0];
    assert.deepEqual(envOf(args), {
      SVC: 'gluesync-conductor',
      NEW_IMAGE: 'conductor:2',
      ROLLBACK_IMAGE: 'conductor:1',
    });
    assert.ok(args.includes('docker:27'));
    assert.deepEqual(logged[0][0], {
      serviceName: 'gluesync-conductor',
      newImage: 'conductor:2',
      rollbackImage: 'conductor:1',
    });
  });

  it('skips the rollback when the compose file already has the previous image', async () => {
    const { autoRebootLinux, spawned, logged } = load(compose);
    await autoRebootLinux({
      hostProjectDir: '/srv/gs',
      rollbackImage: 'conductor:2',
    });
    assert.deepEqual(envOf(spawned[0].args), {
      SVC: 'gluesync-conductor',
      NEW_IMAGE: '',
      ROLLBACK_IMAGE: '',
    });
    assert.deepEqual(logged[0][0], {
      serviceName: 'gluesync-conductor',
      newImage: 'conductor:2',
      rollbackImage: undefined,
    });
  });

  it('skips the rollback when the service image cannot be read', async () => {
    const unreadable = load(new Error('no compose file'));
    await unreadable.autoRebootLinux({
      hostProjectDir: '/srv/gs',
      rollbackImage: 'conductor:1',
    });
    assert.equal(envOf(unreadable.spawned[0].args).ROLLBACK_IMAGE, '');

    const missing = load({ services: {} });
    await missing.autoRebootLinux({
      hostProjectDir: '/srv/gs',
      rollbackImage: 'conductor:1',
    });
    assert.equal(envOf(missing.spawned[0].args).NEW_IMAGE, '');

    const noServices = load({});
    await noServices.autoRebootLinux({
      hostProjectDir: '/srv/gs',
      rollbackImage: 'conductor:1',
    });
    assert.equal(envOf(noServices.spawned[0].args).ROLLBACK_IMAGE, '');
  });
});
