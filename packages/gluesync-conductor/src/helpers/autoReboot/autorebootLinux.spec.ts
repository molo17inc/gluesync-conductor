import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

// The rollback runs in a busybox shell in a helper container: run the real
// script here, with a fake docker that always reports a crashing container.
describe('autoRebootLinux rollback script', () => {
  const NEW = 'molo17/conductor:2';

  const composeText = (image: string): string =>
    `services:\n  gluesync-conductor:\n    image: ${image}\n    restart: always\n`;

  const scriptFor = async (rollbackImage: string): Promise<string> => {
    const { autoRebootLinux, spawned } = load(compose);
    await autoRebootLinux({ hostProjectDir: '/srv/gs', rollbackImage });
    return spawned[0].args[spawned[0].args.length - 1];
  };

  const runRollback = async (
    original: string,
    rollbackImage: string,
    extraEnv: Record<string, string> = {},
  ) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rollback-'));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const shim = (name: string, body: string): void => {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    shim(
      'docker',
      'case "$*" in "compose ps"*) echo abc ;; inspect*) echo "exited 0 1" ;; *) exit 0 ;; esac',
    );
    // macOS has no truncate; dd seeks and cuts the same way
    shim('truncate', 'exec dd if=/dev/null of="$3" bs=1 seek="$2" 2>/dev/null');
    // makes the padding write fail after two bytes, like a disk filling up
    shim(
      'head',
      // eslint-disable-next-line no-template-curly-in-string -- shell, not a template
      'if [ "$1" = "-c" ] && [ -n "${FAIL_PAD:-}" ]; then printf "\\n\\n"; exit 1; fi\nexec "$REAL_HEAD" "$@"',
    );
    const file = path.join(dir, 'docker-compose.yml');
    writeFileSync(file, original);
    const inode = statSync(file).ino;

    const realHead = spawnSync('sh', ['-c', 'command -v head'], {
      encoding: 'utf8',
    }).stdout.trim();
    spawnSync('sh', ['-c', await scriptFor(rollbackImage)], {
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        REAL_HEAD: realHead,
        SVC: 'gluesync-conductor',
        NEW_IMAGE: NEW,
        ROLLBACK_IMAGE: rollbackImage,
        ...extraEnv,
      },
      encoding: 'utf8',
    });
    return {
      text: readFileSync(file, 'utf8'),
      sameInode: statSync(file).ino === inode,
      log: readFileSync(
        path.join(dir, 'logs', 'conductor-self-update.log'),
        'utf8',
      ),
      leftovers: existsSync(path.join(dir, 'docker-compose.yml.tmp')),
    };
  };

  it('puts a shorter previous image back in the same file', async () => {
    const result = await runRollback(composeText(NEW), 'molo17/conductor:1');
    assert.equal(result.text, composeText('molo17/conductor:1'));
    assert.equal(result.sameInode, true);
    assert.match(
      result.log,
      /rolled back gluesync-conductor to molo17\/conductor:1/,
    );
  });

  it('puts a longer previous image back in the same file', async () => {
    const longer = 'registry.example.com/molo17/conductor:1.0.0-long';
    const result = await runRollback(composeText(NEW), longer);
    assert.equal(result.text, composeText(longer));
    assert.equal(result.sameInode, true);
  });

  it('leaves the file alone when the padding cannot be written', async () => {
    const longer = 'registry.example.com/molo17/conductor:1.0.0-long';
    const result = await runRollback(composeText(NEW), longer, {
      FAIL_PAD: '1',
    });
    assert.equal(result.text, composeText(NEW));
    assert.match(
      result.log,
      /rollback not applied: not enough free disk space/,
    );
    assert.doesNotMatch(result.log, /rolled back/);
  });

  it('never writes an empty compose file', async () => {
    const result = await runRollback('', 'molo17/conductor:1');
    assert.equal(result.text, '');
    assert.match(result.log, /rollback not applied/);
  });

  it('does not touch a file without the new image', async () => {
    const other = composeText('molo17/other:9');
    const result = await runRollback(other, 'molo17/conductor:1');
    assert.equal(result.text, other);
    assert.match(result.log, /could not find image/);
  });

  it('no longer truncates the compose file with a redirect', async () => {
    const script = await scriptFor('molo17/conductor:1');
    assert.doesNotMatch(script, />\s*"\$FILE"\s*$/m);
    assert.match(script, /conv=notrunc/);
  });
});
