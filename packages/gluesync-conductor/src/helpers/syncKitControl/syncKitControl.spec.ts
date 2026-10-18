/* eslint-disable functional/immutable-data, no-bitwise */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  CommandResult,
  CommandRunner,
  SyncKitControlOptions,
} from './syncKitControl.model';
import syncKitControl, {
  RUN_SH_SHIM_MARKER,
  buildHostSetupArgs,
  buildHostSetupScript,
  compareVersions,
  parseVersion,
} from './syncKitControl';

type Call = Readonly<{ cmd: string; args: ReadonlyArray<string> }>;

const SHIM = `#!/usr/bin/env bash\nexec "$dir/gluesync" run --folder "$dir" "$@"\n`;
const OLD_RUN_SH = '#!/bin/bash\ndocker compose up -d\n';
const NOW = new Date('2026-10-18T09:08:07.654Z');
const TIMESTAMP = '20261018-090807';
const HOST_PATH = '/opt/gluesync';

const fakeBinary = (arch: string, version: string): string =>
  `fake ${arch} binary, version ${version}\n`;

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe('parseVersion', () => {
  it('takes the first dotted number', () => {
    assert.equal(parseVersion('Gluesync Control 1.4.2.425'), '1.4.2.425');
    assert.equal(parseVersion('v2.0 (build 7.8.9)'), '2.0');
  });

  it('returns null without a dotted number', () => {
    assert.equal(parseVersion('no version here 42'), null);
    assert.equal(parseVersion(''), null);
  });
});

describe('compareVersions', () => {
  it('compares numerically part by part', () => {
    assert.ok(compareVersions('1.4.2.425', '1.4.2.99') > 0);
    assert.ok(compareVersions('1.4.2.425', '1.4.10.1') < 0);
    assert.ok(compareVersions('2.0.0.0', '1.99.99.99') > 0);
    assert.equal(compareVersions('1.4.2.425', '1.4.2.425'), 0);
  });

  it('treats missing parts as zero', () => {
    assert.equal(compareVersions('1.4', '1.4.0.0'), 0);
    assert.ok(compareVersions('1.4.0.1', '1.4') > 0);
    assert.ok(compareVersions('1.4', '1.4.1') < 0);
  });
});

describe('buildHostSetupArgs / buildHostSetupScript', () => {
  it('builds the privileged nsenter helper run', () => {
    const args = buildHostSetupArgs('sha256:abc', HOST_PATH);

    assert.deepEqual(args.slice(0, 10), [
      'run',
      '--rm',
      '--privileged',
      '--pid=host',
      '--net=host',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      'sha256:abc',
      'nsenter',
      '-t',
    ]);
    assert.deepEqual(args.slice(10, 19), [
      '1',
      '-m',
      '-u',
      '-i',
      '-n',
      '-p',
      '--',
      'sh',
      '-c',
    ]);
    assert.equal(args[19], buildHostSetupScript(HOST_PATH));
    assert.equal(args.length, 20);
  });

  it('quotes the host path and is valid sh', () => {
    const script = buildHostSetupScript("/srv/it's a kit");

    assert.ok(script.startsWith(`H='/srv/it'\\''s a kit'\n`));
    assert.ok(script.includes('ln -sfn "$H/gluesync" "$BIN_DIR/gluesync"'));
    assert.ok(script.includes('"$H/gluesync" self-update --enable-auto'));
    execFileSync('sh', ['-n', '-c', script]);
  });
});

describe('syncKitControl', () => {
  const state: { dir: string; root: string; bundle: string; calls: Call[] } = {
    dir: '',
    root: '',
    bundle: '',
    calls: [],
  };

  beforeEach(async () => {
    state.dir = await mkdtemp(join(tmpdir(), 'kit-control-'));
    state.root = join(state.dir, 'root-folder');
    state.bundle = join(state.dir, 'kit-control');
    state.calls = [];
    await mkdir(state.root);
    await mkdir(state.bundle);
    await writeFile(join(state.root, 'docker-compose.yml'), 'services: {}\n');
  });

  afterEach(async () => {
    await rm(state.dir, { recursive: true, force: true });
  });

  const writeBundle = async (version: string): Promise<void> => {
    await writeFile(
      join(state.bundle, 'gluesync-linux-amd64'),
      fakeBinary('amd64', version),
    );
    await writeFile(
      join(state.bundle, 'gluesync-linux-arm64'),
      fakeBinary('arm64', version),
    );
    await writeFile(join(state.bundle, 'run.sh'), SHIM);
    await writeFile(join(state.bundle, 'VERSION'), `${version}\n`);
  };

  const installBinaries = async (
    version: string,
    content?: string,
  ): Promise<void> => {
    await writeFile(
      join(state.root, 'gluesync-linux-amd64'),
      content ?? fakeBinary('amd64', version),
    );
    await writeFile(
      join(state.root, 'gluesync-linux-arm64'),
      content ?? fakeBinary('arm64', version),
    );
    await chmod(join(state.root, 'gluesync-linux-amd64'), 0o755);
    await chmod(join(state.root, 'gluesync-linux-arm64'), 0o755);
  };

  const writeOldKit = async (): Promise<void> => {
    await Promise.all(
      ['stop.sh', 'update.sh', 'collect-logs.sh', 'gluesync-cli'].map(name =>
        writeFile(join(state.root, name), `old ${name}\n`),
      ),
    );
    await writeFile(join(state.root, 'run.sh'), OLD_RUN_SH);
  };

  const runner =
    (
      hostResult: CommandResult = { code: 0, stdout: 'linked\n', stderr: '' },
      inspectResult: CommandResult = {
        code: 0,
        stdout: 'sha256:ownimage\n',
        stderr: '',
      },
    ): CommandRunner =>
    async (cmd, args) => {
      state.calls.push({ cmd, args });

      if (cmd === 'docker') {
        return args[0] === 'inspect' ? inspectResult : hostResult;
      }

      const content = await readFile(cmd, 'utf8').catch(() => null);
      const version = content ? /version (\S+)/.exec(content)?.[1] : undefined;

      return content && version && !content.includes('BROKEN')
        ? { code: 0, stdout: `Gluesync Control ${version}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'cannot run' };
    };

  const sync = (overrides: Partial<SyncKitControlOptions> = {}) =>
    syncKitControl({
      rootFolder: state.root,
      bundleDirs: [state.bundle],
      ownArch: 'amd64',
      hostKitPath: HOST_PATH,
      containerId: 'conductor-container',
      fallbackHelperImage: 'docker:28',
      now: () => NOW,
      run: runner(),
      logger: noopLogger,
      ...overrides,
    });

  const dockerRuns = (): ReadonlyArray<Call> =>
    state.calls.filter(
      ({ cmd, args }) => cmd === 'docker' && args[0] === 'run',
    );

  it('migrates a fresh old kit: binaries, link, shim, legacy moves, marker, host setup', async () => {
    await writeBundle('1.4.2.425');
    await writeOldKit();

    const result = await sync();

    assert.equal(result.success, true);
    assert.equal(result.skipped, false);
    assert.deepEqual([...result.binariesWritten].sort(), [
      'gluesync-linux-amd64',
      'gluesync-linux-arm64',
    ]);
    assert.equal(
      await readFile(join(state.root, 'gluesync-linux-amd64'), 'utf8'),
      fakeBinary('amd64', '1.4.2.425'),
    );
    assert.equal(
      await readFile(join(state.root, 'gluesync-linux-arm64'), 'utf8'),
      fakeBinary('arm64', '1.4.2.425'),
    );
    assert.equal(
      (await stat(join(state.root, 'gluesync-linux-amd64'))).mode & 0o777,
      0o755,
    );

    assert.equal(result.linkCreated, true);
    assert.equal(
      await readlink(join(state.root, 'gluesync')),
      'gluesync-linux-amd64',
    );

    assert.equal(result.runShWritten, true);
    assert.equal(await readFile(join(state.root, 'run.sh'), 'utf8'), SHIM);
    assert.equal((await stat(join(state.root, 'run.sh'))).mode & 0o777, 0o755);

    const legacy = join(state.root, '.legacy', TIMESTAMP);
    assert.deepEqual([...result.legacyMoved].sort(), [
      'collect-logs.sh',
      'gluesync-cli',
      'stop.sh',
      'update.sh',
    ]);
    assert.deepEqual((await readdir(legacy)).sort(), [
      'collect-logs.sh',
      'gluesync-cli',
      'run.sh',
      'stop.sh',
      'update.sh',
    ]);
    assert.equal(await readFile(join(legacy, 'run.sh'), 'utf8'), OLD_RUN_SH);
    assert.equal(
      await readFile(join(legacy, 'stop.sh'), 'utf8'),
      'old stop.sh\n',
    );
    assert.equal(await exists(join(state.root, 'stop.sh')), false);
    assert.equal(await exists(join(state.root, 'collect-logs.sh')), false);

    assert.equal(result.migrated, true);
    assert.equal(
      await readFile(join(state.root, '.gluesync-control-migrated'), 'utf8'),
      '2026-10-18T09:08:07.654Z\n1.4.2.425\n',
    );

    assert.equal(result.hostSetup, 'done');
    const [run] = dockerRuns();
    assert.deepEqual(
      run?.args,
      buildHostSetupArgs('sha256:ownimage', HOST_PATH),
    );
    assert.ok(
      (
        await readFile(join(state.root, '.gluesync-control-host-setup'), 'utf8')
      ).startsWith('2026-10-18T09:08:07.654Z\nlinked'),
    );
  });

  it('leaves a new kit with the same version alone: no marker, no host setup', async () => {
    await writeBundle('1.4.2.425');
    await installBinaries('1.4.2.425');
    await symlink('gluesync-linux-amd64', join(state.root, 'gluesync'));
    await writeFile(join(state.root, 'run.sh'), SHIM);
    const before = await readFile(join(state.root, 'gluesync-linux-amd64'));

    const result = await sync();

    assert.equal(result.success, true);
    assert.deepEqual(result.binariesWritten, []);
    assert.equal(result.linkCreated, false);
    assert.equal(result.runShWritten, false);
    assert.deepEqual(result.legacyMoved, []);
    assert.equal(result.migrated, false);
    assert.equal(result.hostSetup, 'not-needed');
    assert.deepEqual(
      await readFile(join(state.root, 'gluesync-linux-amd64')),
      before,
    );
    assert.equal(
      await exists(join(state.root, '.gluesync-control-migrated')),
      false,
    );
    assert.equal(await exists(join(state.root, '.legacy')), false);
    assert.deepEqual(dockerRuns(), []);
  });

  it('never downgrades a binary that is newer than the bundle', async () => {
    await writeBundle('1.4.2.425');
    await installBinaries('1.5.0.1');

    const result = await sync();

    assert.deepEqual(result.binariesWritten, []);
    assert.equal(
      await readFile(join(state.root, 'gluesync-linux-amd64'), 'utf8'),
      fakeBinary('amd64', '1.5.0.1'),
    );
    assert.equal(
      await readFile(join(state.root, 'gluesync-linux-arm64'), 'utf8'),
      fakeBinary('arm64', '1.5.0.1'),
    );
    assert.equal(result.migrated, false);
  });

  it('replaces both binaries when the bundle is newer, without leaving temp files', async () => {
    await writeBundle('1.4.2.425');
    await installBinaries('1.4.2.99');
    await symlink('gluesync-linux-amd64', join(state.root, 'gluesync'));
    await writeFile(join(state.root, 'run.sh'), SHIM);

    const result = await sync();

    assert.deepEqual([...result.binariesWritten].sort(), [
      'gluesync-linux-amd64',
      'gluesync-linux-arm64',
    ]);
    assert.equal(
      await readFile(join(state.root, 'gluesync-linux-amd64'), 'utf8'),
      fakeBinary('amd64', '1.4.2.425'),
    );
    assert.equal(
      await readFile(join(state.root, 'gluesync-linux-arm64'), 'utf8'),
      fakeBinary('arm64', '1.4.2.425'),
    );
    assert.equal(
      (await readdir(state.root)).filter(name => name.includes('.tmp-')).length,
      0,
    );
    // an update of an existing kit is not a migration
    assert.equal(result.migrated, false);
    assert.equal(result.hostSetup, 'not-needed');
  });

  it('writes only the missing arch file when the installed version is current', async () => {
    await writeBundle('1.4.2.425');
    await writeFile(
      join(state.root, 'gluesync-linux-amd64'),
      fakeBinary('amd64', '1.4.2.425'),
    );

    const result = await sync();

    assert.deepEqual(result.binariesWritten, ['gluesync-linux-arm64']);
    assert.equal(result.migrated, false);
  });

  it('does not overwrite a binary whose version cannot be determined, nor move legacy files', async () => {
    await writeBundle('1.4.2.425');
    await installBinaries('0', 'BROKEN binary\n');
    await writeOldKit();

    const result = await sync();

    assert.deepEqual(result.binariesWritten, []);
    assert.equal(
      await readFile(join(state.root, 'gluesync-linux-amd64'), 'utf8'),
      'BROKEN binary\n',
    );
    assert.deepEqual(result.legacyMoved, []);
    assert.equal(await exists(join(state.root, 'stop.sh')), true);
    assert.equal(
      await exists(join(state.root, '.legacy', TIMESTAMP, 'stop.sh')),
      false,
    );
    assert.equal(result.migrated, false);
  });

  it('never replaces a gluesync that is not a symlink', async () => {
    await writeBundle('1.4.2.425');
    await writeFile(join(state.root, 'gluesync'), 'my own wrapper\n');

    const result = await sync();

    assert.equal(result.linkCreated, false);
    assert.equal(
      (await lstat(join(state.root, 'gluesync'))).isSymbolicLink(),
      false,
    );
    assert.equal(
      await readFile(join(state.root, 'gluesync'), 'utf8'),
      'my own wrapper\n',
    );
  });

  it('leaves a run.sh that already is the shim untouched', async () => {
    await writeBundle('1.4.2.425');
    const custom = `${SHIM}# user note\n`;
    assert.ok(custom.includes(RUN_SH_SHIM_MARKER));
    await writeFile(join(state.root, 'run.sh'), custom);

    const result = await sync();

    assert.equal(result.runShWritten, false);
    assert.equal(await readFile(join(state.root, 'run.sh'), 'utf8'), custom);
    assert.equal(await exists(join(state.root, '.legacy')), false);
  });

  it('writes the shim when run.sh is missing', async () => {
    await writeBundle('1.4.2.425');

    const result = await sync();

    assert.equal(result.runShWritten, true);
    assert.equal(await readFile(join(state.root, 'run.sh'), 'utf8'), SHIM);
  });

  it('skips when the bundle is missing', async () => {
    const result = await sync({ bundleDirs: [join(state.dir, 'nope')] });

    assert.equal(result.skipped, true);
    assert.equal(result.success, true);
    assert.equal(await exists(join(state.root, 'gluesync-linux-amd64')), false);
    assert.deepEqual(state.calls, []);
  });

  it('skips when the bundle is incomplete', async () => {
    await writeBundle('1.4.2.425');
    await rm(join(state.bundle, 'gluesync-linux-arm64'));

    const result = await sync();

    assert.equal(result.skipped, true);
    assert.equal(await exists(join(state.root, 'gluesync-linux-amd64')), false);
  });

  it('uses the next bundle folder when the first is missing', async () => {
    await writeBundle('1.4.2.425');

    const result = await sync({
      bundleDirs: [join(state.dir, 'nope'), state.bundle],
    });

    assert.equal(result.skipped, false);
    assert.equal(result.binariesWritten.length, 2);
  });

  it('skips when the folder is not a docker kit', async () => {
    await writeBundle('1.4.2.425');
    await rm(join(state.root, 'docker-compose.yml'));

    const result = await sync();

    assert.equal(result.skipped, true);
    assert.equal(await exists(join(state.root, 'gluesync-linux-amd64')), false);
  });

  it('accepts docker-compose.yaml as the compose file', async () => {
    await writeBundle('1.4.2.425');
    await rm(join(state.root, 'docker-compose.yml'));
    await writeFile(join(state.root, 'docker-compose.yaml'), 'services: {}\n');

    const result = await sync();

    assert.equal(result.skipped, false);
  });

  it('does not write the host-setup marker when the helper fails, and retries at the next start', async () => {
    await writeBundle('1.4.2.425');
    await writeOldKit();

    const failing = await sync({
      run: runner({ code: 1, stdout: '', stderr: 'boom' }),
    });

    assert.equal(failing.hostSetup, 'failed');
    assert.equal(
      await exists(join(state.root, '.gluesync-control-host-setup')),
      false,
    );
    assert.equal(
      await exists(join(state.root, '.gluesync-control-migrated')),
      true,
    );

    const retried = await sync();

    assert.equal(retried.hostSetup, 'done');
    assert.equal(retried.migrated, false);
    assert.equal(
      await exists(join(state.root, '.gluesync-control-host-setup')),
      true,
    );

    const again = await sync();
    assert.equal(again.hostSetup, 'not-needed');
  });

  it('falls back to the configured helper image when the own image is unknown', async () => {
    await writeBundle('1.4.2.425');

    const result = await sync({
      run: runner(undefined, { code: 1, stdout: '', stderr: 'No such object' }),
      fallbackHelperImage: 'registry.example/helper:1',
    });

    assert.equal(result.hostSetup, 'done');
    assert.deepEqual(
      dockerRuns()[0]?.args,
      buildHostSetupArgs('registry.example/helper:1', HOST_PATH),
    );
    assert.deepEqual(
      state.calls.find(({ args }) => args[0] === 'inspect')?.args,
      ['inspect', '--format', '{{.Image}}', 'conductor-container'],
    );
  });

  it('skips the host setup, and retries later, when BASE_PATH is empty', async () => {
    await writeBundle('1.4.2.425');

    const result = await sync({ hostKitPath: '' });

    assert.equal(result.hostSetup, 'skipped');
    assert.deepEqual(dockerRuns(), []);
    assert.equal(
      await exists(join(state.root, '.gluesync-control-host-setup')),
      false,
    );
  });

  it('never throws', async () => {
    await writeBundle('1.4.2.425');

    const result = await sync({
      run: () => Promise.reject(new Error('runner exploded')),
    });

    assert.equal(typeof result.success, 'boolean');
  });
});
