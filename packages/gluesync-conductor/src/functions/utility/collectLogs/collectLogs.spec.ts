import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';
import {
  FakeSupportPortal,
  startFakeSupportPortal,
} from '../../../testing/fakeSupportPortal';

type Reply = Readonly<{
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
  streamError?: unknown;
}>;

type Script = (command: string, args: ReadonlyArray<string>) => Reply;

type Call = Readonly<{ command: string; args: ReadonlyArray<string> }>;

type LegacyResult = Readonly<{ success: boolean; output: string }>;

type AxiosCall = Readonly<{ url: string; method?: string }>;

type Doubles = {
  script: Script;
  calls: Call[];
  axios: (call: AxiosCall) => Promise<unknown>;
  axiosCalls: AxiosCall[];
  legacy: () => Promise<LegacyResult>;
  legacyCalls: number;
  legacyArgs: Array<Readonly<{ ticketId?: string; email?: string }>>;
};

const doubles: Doubles = {
  script: () => ({ code: 0 }),
  calls: [],
  axios: async () => undefined,
  axiosCalls: [],
  legacy: async () => ({ success: true, output: 'legacy ok' }),
  legacyCalls: 0,
  legacyArgs: [],
};

const fakeSpawn = (command: string, args: ReadonlyArray<string>) => {
  doubles.calls.push({ command, args: [...args] });
  const reply = doubles.script(command, args);
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
  });

  setImmediate(() => {
    if (reply.streamError !== undefined) {
      child.stdout.destroy(reply.streamError as Error);
      child.stderr.end();
      child.emit('close', reply.code ?? 0);
      return;
    }

    child.stdout.end(reply.stdout ?? '');
    child.stderr.end(reply.stderr ?? '');

    if (reply.error) {
      child.emit('error', reply.error);
      return;
    }

    child.emit('close', reply.code ?? 0);
  });

  return child;
};

const subject = path.resolve(__dirname, './collectLogs');

const { collectLogsInternals: internals, default: collectLogsHandler } =
  loadWithStubs<{
    collectLogsInternals: typeof import('./collectLogs').collectLogsInternals;
    default: typeof import('./collectLogs').default;
  }>(subject, {
    [path.resolve(
      __dirname,
      '../../../helpers/orchestrator/getOrchestrator/getOrchestrator',
    )]: { default: async () => ({ mode: 'compose' }) },
    'node:child_process': { spawn: fakeSpawn },
    [path.resolve(__dirname, '../../../utils/axiosWithRetry')]: {
      default: async (url: string, opts: Readonly<{ method?: string }>) => {
        const call = { url, method: opts.method };
        doubles.axiosCalls.push(call);
        return doubles.axios(call);
      },
    },
    [path.resolve(
      __dirname,
      '../../../helpers/collectLogsByScript/collectLogsByScript',
    )]: {
      default: async (
        args: Readonly<{ ticketId?: string; email?: string }>,
      ) => {
        doubles.legacyCalls += 1;
        doubles.legacyArgs.push(args);
        return doubles.legacy();
      },
    },
  });

const noop = (): void => undefined;

type Entry = Readonly<{ fields: unknown; message?: string }>;

const recordingLogger = () => {
  const entries: Record<string, Entry[]> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  const log =
    (level: string) =>
    (fields: unknown, message?: string): void => {
      entries[level].push({ fields, message });
    };

  return {
    entries,
    logger: {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },
  };
};

// 100+ bytes starting with the gzip magic: what isArchiveValid accepts
const gzipLike = (): Buffer =>
  Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(200)]);

const zipLike = (): Buffer =>
  Buffer.concat([Buffer.from([0x50, 0x4b]), Buffer.alloc(200)]);

const valueAfter = (args: ReadonlyArray<string>, flag: string): string =>
  args[args.indexOf(flag) + 1];

// One mocked clock step per event-loop turn, until `isDone`
const pump = async (isDone: () => boolean, stepMs: number): Promise<void> => {
  await new Promise(resolve => {
    setImmediate(resolve);
  });
  if (isDone()) {
    return;
  }
  mock.timers.tick(stepMs);
  await pump(isDone, stepMs);
};

// Runs `work` while stepping the mocked timers (WebDAV retry back-off)
const withFastTimers = async <T>(work: () => Promise<T>): Promise<T> => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const state = { settled: false };
  const running = work();
  const guarded = running.finally(() => {
    state.settled = true;
  });
  guarded.catch(noop);

  await pump(() => state.settled, 1000);

  return running;
};

const tmpRoots: string[] = [];
const makeTmp = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'collect-logs-spec-'));
  tmpRoots.push(dir);
  return dir;
};

const ENV_KEYS = [
  'PROJECT_CWD',
  'IS_WINDOWS',
  'COLLECT_LOGS_FROM_FILES',
  'COLLECT_LOG_LOOKBACK_DAYS',
  'COLLECT_DOCKER_LOG_SINCE_HOURS',
  'COLLECT_DOCKER_LOG_TAIL_LINES',
  'PROXY_HTTPS',
  'PROXY_HTTP',
  'FTP_UPLOAD_DISABLE_EPSV',
  'GLUESYNC_SUPPORT_API_URL',
];
const savedEnv = new Map<string, string | undefined>();
const originalCwd = process.cwd();

beforeEach(() => {
  ENV_KEYS.forEach(key => {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  });
  doubles.script = () => ({ code: 0 });
  doubles.calls.length = 0;
  doubles.axios = async () => undefined;
  doubles.axiosCalls.length = 0;
  doubles.legacy = async () => ({ success: true, output: 'legacy ok' });
  doubles.legacyCalls = 0;
  doubles.legacyArgs.length = 0;
});

afterEach(() => {
  mock.timers.reset();
  process.chdir(originalCwd);
  ENV_KEYS.forEach(key => {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  tmpRoots.splice(0).forEach(dir => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('runCommandCapture', () => {
  it('captures the output and the exit code', async () => {
    doubles.script = () => ({ code: 3, stdout: 'out', stderr: 'err' });

    assert.deepEqual(await internals.runCommandCapture('x', ['a']), {
      exitCode: 3,
      stdout: 'out',
      stderr: 'err',
    });
  });

  it('resolves with the spawn error message when stderr is empty', async () => {
    doubles.script = () => ({ error: new Error('spawn ENOENT') });

    assert.deepEqual(await internals.runCommandCapture('x', []), {
      exitCode: 1,
      stdout: '',
      stderr: 'spawn ENOENT',
    });
  });

  it('prefers the captured stderr over the spawn error message', async () => {
    doubles.script = () => ({ error: new Error('late'), stderr: 'captured' });

    const result = await internals.runCommandCapture('x', []);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, 'captured');
  });

  it('resolves with exit code 1 when reading the output fails', async () => {
    doubles.script = () => ({ streamError: new Error('read failed') });

    assert.deepEqual(await internals.runCommandCapture('x', []), {
      exitCode: 1,
      stdout: '',
      stderr: 'read failed',
    });
  });

  it('stringifies a read failure that is not an Error', async () => {
    doubles.script = () => ({ streamError: 'plain failure' });

    const result = await internals.runCommandCapture('x', []);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /plain failure/);
  });
});

describe('collectFromDirSafe', () => {
  it('collects .log and .err files recursively', async () => {
    const root = makeTmp();
    mkdirSync(path.join(root, 'nested'));
    writeFileSync(path.join(root, 'a.log'), 'a');
    writeFileSync(path.join(root, 'b.txt'), 'b');
    writeFileSync(path.join(root, 'nested', 'c.ERR'), 'c');

    const result = await internals.collectFromDirSafe(root, {
      isWindows: false,
    });

    assert.deepEqual([...result.files].sort(), [
      path.join(root, 'a.log'),
      path.join(root, 'nested', 'c.ERR'),
    ]);
    assert.deepEqual(result.scan, { path: root, exists: true, matched: 2 });
  });

  it('skips the excluded directory', async () => {
    const root = makeTmp();
    mkdirSync(path.join(root, 'extra'));
    writeFileSync(path.join(root, 'a.log'), 'a');
    writeFileSync(path.join(root, 'extra', 'x.log'), 'x');

    const result = await internals.collectFromDirSafe(root, {
      isWindows: false,
      excludeDir: path.join(root, 'extra'),
    });

    assert.deepEqual(result.files, [path.join(root, 'a.log')]);
  });

  it('reports a missing directory', async () => {
    const missing = path.join(makeTmp(), 'nope');

    assert.deepEqual(
      await internals.collectFromDirSafe(missing, { isWindows: false }),
      {
        files: [],
        scan: { path: missing, exists: false, matched: 0 },
      },
    );
  });

  it('reports a path that is not a directory', async () => {
    const file = path.join(makeTmp(), 'file.log');
    writeFileSync(file, 'x');

    assert.deepEqual(
      await internals.collectFromDirSafe(file, { isWindows: false }),
      {
        files: [],
        scan: { path: file, exists: false, matched: 0 },
      },
    );
  });
});

describe('filterRecentFiles', () => {
  it('keeps the files newer than the cutoff and drops old or missing ones', async () => {
    const root = makeTmp();
    const recent = path.join(root, 'recent.log');
    const old = path.join(root, 'old.log');
    writeFileSync(recent, 'r');
    writeFileSync(old, 'o');
    const longAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);

    const result = await internals.filterRecentFiles(
      [recent, old, path.join(root, 'missing.log')],
      Date.now() - 24 * 60 * 60 * 1000,
    );

    assert.deepEqual(result, [recent]);
  });
});

describe('snapshotFile', () => {
  const copyWithCp: Script = (command, args) => {
    if (command === 'cp') {
      copyFileSync(args[1], args[2]);
      return { code: 0 };
    }
    return { code: 1 };
  };

  const setup = () => {
    const root = makeTmp();
    const searchDir = path.join(root, 'search');
    const extraDir = path.join(root, 'extra');
    const snapshotDir = path.join(root, 'snapshot');
    [searchDir, extraDir, snapshotDir].forEach(dir => {
      mkdirSync(dir);
    });
    const { logger, entries } = recordingLogger();

    return {
      root,
      searchDir,
      extraDir,
      snapshotDir,
      entries,
      context: {
        searchDir,
        extraDir,
        snapshotDir,
        isWindows: false,
        logger,
      },
    };
  };

  it('copies with cp, keeping the path relative to the search dir', async () => {
    const env = setup();
    const source = path.join(env.searchDir, 'logs', 'app.log');
    mkdirSync(path.dirname(source));
    writeFileSync(source, 'content');
    doubles.script = copyWithCp;

    const result = await internals.snapshotFile(source, env.context);

    const target = path.join(env.snapshotDir, 'logs', 'app.log');
    assert.deepEqual(result, { ok: true, target, source, method: 'cp' });
    assert.equal(readFileSync(target, 'utf8'), 'content');
  });

  it('places files of the extra dir under diagnostics', async () => {
    const env = setup();
    const source = path.join(env.extraDir, 'system-report.txt');
    writeFileSync(source, 'report');
    doubles.script = copyWithCp;

    const result = await internals.snapshotFile(source, env.context);

    assert.equal(
      result.ok && result.target,
      path.join(env.snapshotDir, 'diagnostics', 'system-report.txt'),
    );
  });

  it('flattens files outside both directories to their basename', async () => {
    const env = setup();
    const source = path.join(env.root, 'elsewhere', 'stray.log');
    mkdirSync(path.dirname(source));
    writeFileSync(source, 'stray');
    doubles.script = copyWithCp;

    const result = await internals.snapshotFile(source, {
      ...env.context,
      extraDir: path.join(env.root, 'other-extra'),
    });

    assert.equal(
      result.ok && result.target,
      path.join(env.snapshotDir, 'stray.log'),
    );
  });

  it('falls back to a Node copy when cp fails', async () => {
    const env = setup();
    const source = path.join(env.searchDir, 'app.log');
    writeFileSync(source, 'node copy');
    doubles.script = () => ({ code: 1, stderr: 'cp: nope' });

    const result = await internals.snapshotFile(source, env.context);

    assert.equal(result.ok && result.method, 'node');
    assert.equal(
      readFileSync(path.join(env.snapshotDir, 'app.log'), 'utf8'),
      'node copy',
    );
    assert.equal(env.entries.debug.length, 1);
  });

  it('reports both reasons when cp and the Node copy fail', async () => {
    const env = setup();
    const source = path.join(env.searchDir, 'gone.log');
    doubles.script = () => ({ code: 1, stderr: 'cp: nope' });

    const result = await internals.snapshotFile(source, env.context);

    assert.equal(result.ok, false);
    assert.equal(result.source, source);
    assert.match(
      result.ok ? '' : result.reason,
      /^native-copy: cp exit 1: cp: nope \| node-copy: /,
    );
    assert.equal(env.entries.warn.length, 1);
  });

  it('excludes the file when the snapshot directory cannot be created', async () => {
    const env = setup();
    const blocker = path.join(env.snapshotDir, 'logs');
    writeFileSync(blocker, 'a file where a directory is needed');
    const source = path.join(env.searchDir, 'logs', 'app.log');

    const result = await internals.snapshotFile(source, env.context);

    assert.equal(result.ok, false);
    assert.equal(env.entries.warn.length, 1);
    assert.equal(doubles.calls.length, 0);
  });

  it('copies with robocopy on Windows', async () => {
    const env = setup();
    const source = path.join(env.searchDir, 'app.log');
    writeFileSync(source, 'win');
    doubles.script = (command, args) => {
      if (command === 'robocopy') {
        copyFileSync(path.join(args[0], args[2]), path.join(args[1], args[2]));
        return { code: 1 };
      }
      return { code: 1 };
    };

    const result = await internals.snapshotFile(source, {
      ...env.context,
      isWindows: true,
    });

    assert.equal(result.ok && result.method, 'robocopy');
  });

  it('falls back to a Node copy when robocopy fails on Windows', async () => {
    const env = setup();
    const source = path.join(env.searchDir, 'app.log');
    writeFileSync(source, 'win');
    doubles.script = () => ({ code: 16, stderr: 'ERROR' });

    const result = await internals.snapshotFile(source, {
      ...env.context,
      isWindows: true,
    });

    assert.equal(result.ok && result.method, 'node');
  });
});

describe('safeCopyWithRobocopy', () => {
  it('renames the copied file when the target name differs', async () => {
    const root = makeTmp();
    const source = path.join(root, 'src', 'a.log');
    const target = path.join(root, 'dst', 'b.log');
    mkdirSync(path.dirname(source));
    mkdirSync(path.dirname(target));
    writeFileSync(source, 'data');
    doubles.script = (command, args) => {
      copyFileSync(path.join(args[0], args[2]), path.join(args[1], args[2]));
      return { code: 0 };
    };

    assert.deepEqual(await internals.safeCopyWithRobocopy(source, target), {
      ok: true,
    });
    assert.equal(readFileSync(target, 'utf8'), 'data');
    assert.equal(existsSync(path.join(root, 'dst', 'a.log')), false);
  });

  it('fails when the renamed copy is missing', async () => {
    const root = makeTmp();
    const source = path.join(root, 'src', 'a.log');
    const target = path.join(root, 'dst', 'b.log');
    mkdirSync(path.dirname(target));
    doubles.script = () => ({ code: 0 });

    const result = await internals.safeCopyWithRobocopy(source, target);

    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /^robocopy rename failed: /);
  });

  it('fails when robocopy reports success without creating the target', async () => {
    const root = makeTmp();
    const target = path.join(root, 'a.log');
    doubles.script = () => ({ code: 1 });

    const result = await internals.safeCopyWithRobocopy(
      path.join(root, 'a.log'),
      target,
    );

    assert.equal(result.ok, false);
    assert.match(
      result.ok ? '' : result.reason,
      /robocopy reported success \(exit 1\) but target file was not created/,
    );
  });

  it('reports a robocopy failure exit code', async () => {
    doubles.script = () => ({ code: 8, stdout: '  access denied  ' });

    assert.deepEqual(
      await internals.safeCopyWithRobocopy('/s/a.log', '/t/a.log'),
      { ok: false, reason: 'robocopy exit 8: access denied' },
    );
  });
});

describe('safeCopyWithCp', () => {
  it('reports a cp failure with truncated output', async () => {
    doubles.script = () => ({ code: 1, stderr: 'x'.repeat(500) });

    const result = await internals.safeCopyWithCp('/s/a', '/t/a');

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reason,
      `cp exit 1: ${'x'.repeat(300)}`,
    );
  });
});

describe('buildCollectionReportLines', () => {
  const baseInput = {
    isWindows: false,
    logLookbackDays: 5,
    dockerSinceHours: 120,
    dockerTailLines: undefined,
    collectLogsFromFiles: true,
    candidateCount: 3,
    readableCount: 2,
    searchDir: '/srv/root',
    wellKnownLogDirsScanned: [],
    successfulSnapshots: [],
    snapshotFailures: [],
  };

  it('describes a minimal collection', () => {
    const lines = internals.buildCollectionReportLines(baseInput);

    assert.ok(lines.includes('Platform: Linux'));
    assert.ok(lines.includes('Docker tail lines: all'));
    assert.ok(lines.includes('File-based log collection: enabled'));
    assert.ok(lines.includes('Total candidates found:   3'));
    assert.ok(lines.includes('Successfully snapshotted: 0'));
    assert.ok(lines.includes('  searchDir: /srv/root'));
    assert.ok(lines.includes('  cp:       0'));
    assert.equal(
      lines.some(line => line.includes('Snapshot failures')),
      false,
    );
    assert.equal(
      lines.some(line => line.includes('Well-known mount points')),
      false,
    );
  });

  it('lists failures, mount points and the snapshot methods', () => {
    const lines = internals.buildCollectionReportLines({
      ...baseInput,
      isWindows: true,
      dockerTailLines: 200,
      collectLogsFromFiles: false,
      wellKnownLogDirsScanned: [
        { path: '/srv/root/logs', exists: true, matched: 4 },
        { path: '/srv/root/logs/chronos', exists: false, matched: 0 },
      ],
      successfulSnapshots: [
        { ok: true, target: '/t/a', source: '/s/a', method: 'cp' },
        { ok: true, target: '/t/b', source: '/s/b', method: 'cp' },
        { ok: true, target: '/t/c', source: '/s/c', method: 'node' },
      ],
      snapshotFailures: [{ ok: false, source: '/s/d', reason: 'locked' }],
    });

    assert.ok(lines.includes('Platform: Windows'));
    assert.ok(lines.includes('Docker tail lines: 200'));
    assert.ok(lines.includes('File-based log collection: disabled'));
    assert.ok(lines.includes('Failed to snapshot:       1'));
    assert.ok(lines.includes('  FAILED  /s/d'));
    assert.ok(lines.includes('    reason: locked'));
    assert.ok(lines.includes('  Well-known mount points:'));
    assert.ok(lines.includes('    PRESENT  /srv/root/logs  (matched 4)'));
    assert.ok(
      lines.includes('    MISSING  /srv/root/logs/chronos  (matched 0)'),
    );
    assert.ok(lines.includes('  cp:       2'));
    assert.ok(lines.includes('  node:     1'));
    assert.ok(lines.includes('  OK  [node]  /s/c'));
  });
});

describe('createArchive on Windows', () => {
  it('builds the Compress-Archive script with escaped quotes and a raw wildcard', async () => {
    const root = makeTmp();
    const searchDir = path.join(root, 'se"arch');
    const outputDir = path.join(root, 'out');
    mkdirSync(searchDir);
    mkdirSync(outputDir);
    const file = path.join(searchDir, 'a.log');
    writeFileSync(file, 'a');
    const scripts: string[] = [];
    doubles.script = (command, args) => {
      const script = valueAfter(args, '-Command');
      scripts.push(script);
      const dest = /\$dest = "(.*)";/.exec(script)?.[1] ?? '';
      writeFileSync(dest.replaceAll('""', '"'), zipLike());
      return { code: 0 };
    };

    const archive = await internals.createArchive(
      searchDir,
      outputDir,
      [file],
      true,
    );

    assert.match(archive, /\.zip$/);
    assert.equal(doubles.calls[0].command, 'pwsh');
    assert.ok(
      scripts[0].includes(`$source = "${searchDir.replaceAll('"', '""')}";`),
    );
    assert.ok(scripts[0].includes('Compress-Archive -Path "$source\\*"'));
    assert.equal(scripts[0].includes('$source\\\\*'), false);
  });
});

describe('createArchiveWithFallback', () => {
  const setup = () => {
    const root = makeTmp();
    const snapshotDir = path.join(root, 'snapshot');
    mkdirSync(snapshotDir);
    const file = path.join(snapshotDir, 'a.log');
    writeFileSync(file, 'a');
    const { logger, entries } = recordingLogger();
    const context = (localOnly: boolean) => ({
      ticket: 'T-1',
      email: 'a@b.c',
      isWindows: false,
      localOnly,
      logger,
    });

    return { root, snapshotDir, file, entries, context };
  };

  const tarCreates: Script = (command, args) => {
    if (command === 'tar') {
      writeFileSync(args[1], gzipLike());
      return { code: 0 };
    }
    return { code: 1 };
  };

  it('returns the archive created internally', async () => {
    const env = setup();
    doubles.script = tarCreates;

    const result = await internals.createArchiveWithFallback(
      env.snapshotDir,
      env.root,
      [env.file],
      env.context(false),
    );

    assert.match(result.archivePath ?? '', /\.tar\.gz$/);
    assert.equal(doubles.legacyCalls, 0);
  });

  it('rethrows the failure in local-only mode', async () => {
    const env = setup();
    doubles.script = () => ({ code: 1 });

    await assert.rejects(
      internals.createArchiveWithFallback(
        env.snapshotDir,
        env.root,
        [env.file],
        env.context(true),
      ),
      /Archive creation failed on all attempts/,
    );
    assert.equal(doubles.legacyCalls, 0);
    assert.equal(env.entries.warn.length > 0, true);
  });

  it('falls back to the legacy script', async () => {
    const env = setup();
    doubles.script = () => ({ code: 1 });
    doubles.legacy = async () => ({ success: true, output: 'legacy done' });

    const result = await internals.createArchiveWithFallback(
      env.snapshotDir,
      env.root,
      [env.file],
      env.context(false),
    );

    assert.equal(result.legacyFallback, true);
    assert.equal(result.archivePath, undefined);
    assert.equal(
      result.output,
      [
        'Internal archive creation failed.',
        'Legacy collect logs script completed successfully.',
        'legacy done',
      ].join('\n'),
    );
  });

  it('fails when the legacy script fails too', async () => {
    const env = setup();
    doubles.script = () => ({ code: 1 });
    doubles.legacy = async () => ({ success: false, output: 'legacy broke' });

    await assert.rejects(
      internals.createArchiveWithFallback(
        env.snapshotDir,
        env.root,
        [env.file],
        env.context(false),
      ),
      (error: Error & { details?: string }) => {
        assert.equal(
          error.message,
          'Archive creation failed and legacy fallback also failed.',
        );
        assert.equal(error.details, 'legacy broke');
        return true;
      },
    );
  });
});

describe('uploadWithFallback', () => {
  const setup = () => {
    const root = makeTmp();
    const archivePath = path.join(root, 'support-logs.tar.gz');
    writeFileSync(archivePath, gzipLike());
    const { logger, entries } = recordingLogger();

    return {
      archivePath,
      entries,
      context: {
        ticket: 'T-1',
        email: 'a@b.c',
        isWindows: false,
        localOnly: false,
        logger,
      },
    };
  };

  const httpFailure = (status: number, statusText: string) =>
    Object.assign(new Error('Request failed'), {
      response: { status, statusText },
    });

  it('uploads through WebDAV and removes the archive', async () => {
    const env = setup();

    const result = await internals.uploadWithFallback(
      env.archivePath,
      env.context,
    );

    assert.deepEqual(result, { uploadedVia: 'webdav' });
    assert.equal(existsSync(env.archivePath), false);
    assert.equal(doubles.axiosCalls.length, 1);
    assert.equal(doubles.axiosCalls[0].method, 'PUT');
    assert.match(doubles.axiosCalls[0].url, /support-logs\.tar\.gz$/);
  });

  it('retries WebDAV with a jittered back-off, then uploads over FTP', async () => {
    const env = setup();
    const failures = { count: 0 };
    doubles.axios = async () => {
      failures.count += 1;
      throw httpFailure(503, 'Service Unavailable');
    };
    doubles.script = () => ({ code: 0 });

    const result = await withFastTimers(() =>
      internals.uploadWithFallback(env.archivePath, env.context),
    );

    assert.deepEqual(result, { uploadedVia: 'ftp' });
    assert.equal(failures.count, 3);
    const curl = doubles.calls.find(
      call => call.command === 'curl' && call.args.includes('-T'),
    );
    assert.ok(curl);
    assert.equal(curl.args.includes('--disable-epsv'), false);
  });

  it('passes the EPSV switch to curl when configured', async () => {
    const env = setup();
    process.env.FTP_UPLOAD_DISABLE_EPSV = 'TRUE';
    doubles.axios = async () => {
      throw new Error('network down');
    };

    await withFastTimers(() =>
      internals.uploadWithFallback(env.archivePath, env.context),
    );

    const curl = doubles.calls.find(call => call.args.includes('-T'));
    assert.ok(curl?.args.includes('--disable-epsv'));
  });

  it('prefixes the WebDAV detail to the FTP failure details', async () => {
    const env = setup();
    doubles.axios = async () => {
      throw httpFailure(500, 'Server Error');
    };
    doubles.script = (command, args) =>
      args.includes('-T') ? { code: 67, stderr: 'login denied' } : { code: 0 };
    doubles.legacy = async () => ({ success: false, output: 'legacy broke' });

    await assert.rejects(
      withFastTimers(() =>
        internals.uploadWithFallback(env.archivePath, env.context),
      ),
      (error: Error & { details?: string }) => {
        assert.equal(
          error.message,
          'Internal collector upload failed and legacy fallback also failed.',
        );
        assert.equal(error.details, 'legacy broke');
        return true;
      },
    );
    assert.equal(existsSync(env.archivePath), false);
    const warned = env.entries.warn.find(entry =>
      String((entry.fields as { error?: Error }).error?.message ?? '').includes(
        'Failed to upload to FTP after WebDAV failure.',
      ),
    );
    assert.ok(warned);
    const { details } = (warned.fields as { error: { details: string } }).error;
    assert.match(
      details,
      /^WebDAV upload failed with HTTP 500 Server Error\nFTP authentication failed \(curl 67\)/,
    );
  });

  it('falls back to the legacy script when the upload fails', async () => {
    const env = setup();
    doubles.axios = async () => {
      throw new Error('network down');
    };
    doubles.script = () => ({ code: 1 });
    doubles.legacy = async () => ({ success: true, output: 'legacy done' });

    const result = await withFastTimers(() =>
      internals.uploadWithFallback(env.archivePath, env.context),
    );

    assert.equal(result.legacyFallback, true);
    assert.equal(
      result.output,
      [
        'Internal collector upload failed.',
        'Legacy collect logs script completed successfully.',
        'legacy done',
      ].join('\n'),
    );
    assert.equal(existsSync(env.archivePath), false);
  });
});

describe('validateCollectLogsInput', () => {
  it('accepts local-only collections without credentials', async () => {
    await internals.validateCollectLogsInput({ localOnly: true }, false);

    assert.equal(doubles.axiosCalls.length, 0);
  });

  it('requires the ticket and the email otherwise', async () => {
    await assert.rejects(
      internals.validateCollectLogsInput(
        { localOnly: false, ticketId: 'T-1' },
        false,
      ),
      /ticketId and email are required unless localOnly is true/,
    );
    await assert.rejects(
      internals.validateCollectLogsInput(
        { localOnly: false, email: 'a@b.c' },
        false,
      ),
      /ticketId and email are required/,
    );
  });

  it('checks the credentials against WebDAV when no proxy is configured', async () => {
    await internals.validateCollectLogsInput(
      { localOnly: false, ticketId: 'T-1', email: 'a@b.c' },
      false,
    );

    assert.equal(doubles.axiosCalls.length, 1);
    assert.equal(doubles.axiosCalls[0].method, 'PROPFIND');
  });

  it('skips the credential check behind a proxy', async () => {
    process.env.PROXY_HTTP = 'http://proxy.local:3128';

    await internals.validateCollectLogsInput(
      { localOnly: false, ticketId: 'T-1', email: 'a@b.c' },
      false,
    );

    assert.equal(doubles.axiosCalls.length, 0);
  });
});

describe('collectLogsInternally', () => {
  type Capture = {
    list: string;
    report: string;
    pwshScript: string;
  };

  const setup = () => {
    const root = makeTmp();
    const searchDir = path.join(root, 'root-folder');
    mkdirSync(path.join(searchDir, 'logs', 'core-hub'), { recursive: true });
    mkdirSync(path.join(searchDir, 'nested'));
    writeFileSync(path.join(searchDir, 'logs', 'app.log'), 'app');
    writeFileSync(path.join(searchDir, 'logs', 'core-hub', 'hub.err'), 'hub');
    writeFileSync(path.join(searchDir, 'nested', 'old.log'), 'old');
    writeFileSync(path.join(searchDir, 'stale.log'), 'stale');
    writeFileSync(path.join(searchDir, 'conf.yaml'), 'key: value');
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(path.join(searchDir, 'nested', 'old.log'), longAgo, longAgo);
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    utimesSync(path.join(searchDir, 'stale.log'), sixDaysAgo, sixDaysAgo);

    process.env.PROJECT_CWD = root;
    process.chdir(root);

    const capture: Capture = { list: '', report: '', pwshScript: '' };
    doubles.script = (command, args) => {
      if (command === 'cp') {
        copyFileSync(args[1], args[2]);
        return { code: 0 };
      }
      if (command === 'tar') {
        capture.list = readFileSync(valueAfter(args, '-T'), 'utf8');
        capture.report = readFileSync(
          path.join(valueAfter(args, '-C'), 'collection-report.txt'),
          'utf8',
        );
        writeFileSync(args[1], gzipLike());
        return { code: 0 };
      }
      return { code: 1 };
    };

    return { root, searchDir, capture };
  };

  it('archives the recent logs and the diagnostics in local-only mode', async () => {
    const env = setup();
    const { logger } = recordingLogger();

    const result = await internals.collectLogsInternally({
      localOnly: true,
      logger,
    });

    assert.ok(result.archivePath);
    assert.equal(existsSync(result.archivePath), true);
    assert.match(result.output, /Local-only mode enabled/);
    assert.match(result.output, /Collecting logs from last 5 day\(s\)/);
    assert.match(result.output, /Upload skipped \(local-only mode\)/);
    assert.equal(
      existsSync(path.join(env.searchDir, 'nested', 'old.log')),
      false,
    );

    const entries = env.capture.list.split('\n');
    assert.ok(entries.includes(path.join('logs', 'app.log')));
    assert.ok(entries.includes(path.join('logs', 'core-hub', 'hub.err')));
    assert.ok(entries.includes('collection-report.txt'));
    assert.equal(entries.includes('stale.log'), false);
    assert.match(env.capture.report, /Platform: Linux/);
    assert.match(env.capture.report, /File-based log collection: enabled/);
    assert.match(env.capture.report, /OK {2}\[cp\] {2}.*app\.log/);
    assert.match(env.capture.report, /PRESENT {2}.*core-hub {2}\(matched 1\)/);
    assert.match(env.capture.report, /MISSING {2}.*chronos {2}\(matched 0\)/);
  });

  it('skips the file-based logs when disabled', async () => {
    const env = setup();
    process.env.COLLECT_LOGS_FROM_FILES = 'false';
    process.env.COLLECT_DOCKER_LOG_TAIL_LINES = '50';

    const result = await internals.collectLogsInternally({ localOnly: true });

    assert.match(result.output, /File-based log collection disabled/);
    assert.match(result.output, /50 tail lines per container/);
    assert.match(env.capture.report, /File-based log collection: disabled/);
    assert.match(env.capture.report, /Docker tail lines: 50/);
    assert.equal(
      env.capture.list.split('\n').includes(path.join('logs', 'app.log')),
      false,
    );
  });

  it('uploads the archive over WebDAV', async () => {
    setup();
    process.env.PROXY_HTTPS = 'http://proxy.local:3128';

    const result = await internals.collectLogsInternally({
      localOnly: false,
      ticketId: 'T-1',
      email: 'a@b.c',
    });

    assert.equal(result.archivePath, undefined);
    assert.match(result.output, /Credential pre-check succeeded/);
    assert.match(result.output, /Archive uploaded successfully via WebDAV/);
    assert.equal(doubles.axiosCalls.length, 1);
  });

  it('reports an upload over the FTP fallback', async () => {
    const env = setup();
    process.env.PROXY_HTTPS = 'http://proxy.local:3128';
    doubles.axios = async () => {
      throw new Error('network down');
    };
    const base = doubles.script;
    doubles.script = (command, args) =>
      command === 'curl' || command === 'which'
        ? { code: 0 }
        : base(command, args);

    const result = await withFastTimers(() =>
      internals.collectLogsInternally({
        localOnly: false,
        ticketId: 'T-1',
        email: 'a@b.c',
      }),
    );

    assert.match(
      result.output,
      /Archive uploaded successfully via FTP fallback/,
    );
    assert.ok(env.capture.list.length > 0);
  });

  it('returns the legacy output when the archive cannot be created', async () => {
    setup();
    process.env.PROXY_HTTPS = 'http://proxy.local:3128';
    const base = doubles.script;
    doubles.script = (command, args) =>
      command === 'tar' ? { code: 1 } : base(command, args);
    doubles.legacy = async () => ({ success: true, output: 'legacy done' });

    const result = await internals.collectLogsInternally({
      localOnly: false,
      ticketId: 'T-1',
      email: 'a@b.c',
    });

    assert.match(result.output, /Internal archive creation failed/);
    assert.match(result.output, /legacy done/);
    assert.equal(doubles.axiosCalls.length, 0);
  });

  it('returns the legacy output when the upload fails', async () => {
    setup();
    process.env.PROXY_HTTPS = 'http://proxy.local:3128';
    doubles.axios = async () => {
      throw new Error('network down');
    };
    const base = doubles.script;
    doubles.script = (command, args) =>
      command === 'which' ? { code: 1 } : base(command, args);
    doubles.legacy = async () => ({ success: true, output: 'legacy done' });

    const result = await withFastTimers(() =>
      internals.collectLogsInternally({
        localOnly: false,
        ticketId: 'T-1',
        email: 'a@b.c',
      }),
    );

    assert.match(result.output, /Internal collector upload failed/);
    assert.match(result.output, /legacy done/);
  });

  it('rejects missing credentials before touching the disk', async () => {
    await assert.rejects(
      internals.collectLogsInternally({ localOnly: false }),
      /ticketId and email are required/,
    );
  });
});

describe('resolveCollectLogsRequest', () => {
  const resolve = internals.resolveCollectLogsRequest;
  const VOUCHER = 'GSV-ABCD-EFGH-JKMN';

  it('ignores every credential in local-only mode', () => {
    assert.deepEqual(resolve({ voucher: 'nonsense', ticketId: '1' }, true), {});
    assert.deepEqual(resolve({}, true), {});
  });

  it('normalizes the voucher', () => {
    assert.deepEqual(resolve({ voucher: ` gsv abcd efgh jkmn ` }, false), {
      voucher: VOUCHER,
    });
  });

  it('refuses a voucher together with ticketId or email, naming the voucher', () => {
    [
      { ticketId: 'GSSD-1' },
      { email: 'a@b.c' },
      { ticketId: '1', email: 'a@b.c' },
    ]
      .map(extra => resolve({ voucher: VOUCHER, ...extra }, false))
      .forEach(result => {
        assert.equal(result.failed, true);
        assert.equal((result as { code?: string }).code, 'validation');
        assert.match((result as { error: string }).error, /voucher/);
      });
  });

  it('refuses a voucher of the wrong shape', () => {
    const result = resolve({ voucher: 'GSV-1234' }, false);

    assert.equal(result.failed, true);
    assert.equal((result as { code?: string }).code, 'voucher_format');
  });

  it('treats a blank voucher as none', () => {
    assert.deepEqual(
      resolve({ voucher: '  ', ticketId: 'GSSD-5', email: 'a@b.c' }, false),
      { ticketId: 'GSSD-5', email: 'a@b.c' },
    );
    assert.equal(resolve({ voucher: '' }, false).failed, true);
  });

  it('asks for the credentials of the legacy path', () => {
    const missing = resolve({ ticketId: 'GSSD-5' }, false);
    assert.equal(missing.failed, true);
    assert.match(
      (missing as { error: string }).error,
      /ticketId and email are required unless localOnly is true/,
    );
    assert.equal((missing as { code?: string }).code, undefined);

    const badMail = resolve({ ticketId: 'GSSD-5', email: 'nope' }, false);
    assert.equal((badMail as { error: string }).error, 'invalid email format');
  });

  it('normalizes the ticket key of the legacy path', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['GSSD-1234', 'GSSD-1234'],
      ['#1234', 'GSSD-1234'],
      ['1234', 'GSSD-1234'],
      ['gssd-1234', 'GSSD-1234'],
      ['not a key!', 'not a key!'],
    ];
    cases.forEach(([given, expected]) => {
      assert.deepEqual(resolve({ ticketId: given, email: 'a@b.c' }, false), {
        ticketId: expected,
        email: 'a@b.c',
      });
    });
  });
});

describe('formatSize', () => {
  it('writes sizes the way people read them', () => {
    assert.equal(internals.formatSize(12), '12 B');
    assert.equal(internals.formatSize(2048), '2.0 KB');
    assert.equal(internals.formatSize(12.3 * 1024 * 1024), '12.3 MB');
    assert.equal(internals.formatSize(3 * 1024 ** 3), '3.0 GB');
  });
});

describe('uploads with a voucher', () => {
  const VOUCHER = 'GSV-ABCD-EFGH-JKMN';
  let portal: FakeSupportPortal;
  let archives: string[];
  let order: string[];

  type Answer = { code: number; payload: any };

  const call = async (body: Record<string, unknown>): Promise<Answer> => {
    const answer: Answer = { code: 0, payload: undefined };
    const reply = {
      code: (status: number) => {
        answer.code = status;
        return reply;
      },
      send: (payload: unknown) => {
        answer.payload = payload;
        return reply;
      },
    };
    const quiet = { info: noop, warn: noop, error: noop, debug: noop };

    await (collectLogsHandler as any)(
      { body, log: quiet, server: { docker: {} } },
      reply,
    );
    return answer;
  };

  beforeEach(async () => {
    portal = await startFakeSupportPortal();
    process.env.GLUESYNC_SUPPORT_API_URL = `${portal.url}/`;
    // Nothing reaches the portal through a proxy in these specs
    delete process.env.PROXY_HTTPS;
    delete process.env.PROXY_HTTP;
    archives = [];
    order = [];

    const root = makeTmp();
    const searchDir = path.join(root, 'root-folder');
    mkdirSync(path.join(searchDir, 'logs'), { recursive: true });
    writeFileSync(path.join(searchDir, 'logs', 'app.log'), 'app');
    process.env.PROJECT_CWD = root;
    process.chdir(root);

    portal.intercept(request => {
      order.push(`${request.method} ${request.path}`);
      return undefined;
    });
    doubles.script = (command, args) => {
      if (command === 'cp') {
        copyFileSync(args[1], args[2]);
        return { code: 0 };
      }
      if (command === 'tar') {
        order.push('tar');
        archives.push(args[1]);
        writeFileSync(args[1], gzipLike());
        return { code: 0 };
      }
      return { code: 1 };
    };
  });

  afterEach(async () => {
    await portal.close();
  });

  it('checks the voucher before collecting, then uploads to the portal only', async () => {
    const answer = await call({ voucher: ` ${VOUCHER.toLowerCase()} ` });

    assert.equal(answer.code, 200);
    assert.equal(answer.payload.success, true);
    assert.equal(answer.payload.uploadedVia, 'portal');
    assert.equal(answer.payload.ticketKey, 'GSSD-1234');
    assert.equal(answer.payload.size, 202);
    assert.equal(answer.payload.verified, true);
    assert.equal(answer.payload.archivePath, undefined);
    assert.match(
      answer.payload.output,
      /Archive uploaded to the support portal \(ticket GSSD-1234, 202 B, verified\)\./,
    );
    assert.match(answer.payload.output, /Local archive removed/);
    assert.equal(archives.length, 1);
    assert.equal(existsSync(archives[0]), false);

    assert.equal(order[0], 'POST /support/log-uploads/check');
    assert.ok(order.indexOf('tar') > 0, 'the check comes before the archive');
    assert.equal(
      portal.calls('/support/log-uploads')[0].json.contentType,
      'application/gzip',
    );
    portal.requests.forEach(request => {
      assert.equal(request.headers['x-gluesync-voucher'] ?? VOUCHER, VOUCHER);
      assert.equal(request.headers.authorization, undefined);
    });
    assert.equal(doubles.axiosCalls.length, 0, 'no WebDAV on this path');
    assert.equal(
      doubles.calls.filter(c => c.command === 'curl').length,
      0,
      'no FTP on this path',
    );
    assert.equal(doubles.legacyCalls, 0);
  });

  it('keeps the archive and returns its path when the size is not verified', async () => {
    portal.intercept(request =>
      request.path.endsWith('/complete')
        ? {
            status: 200,
            body: {
              id: 'up-1',
              ticketKey: 'GSSD-1234',
              size: 100,
              verified: false,
            },
          }
        : undefined,
    );

    const answer = await call({ voucher: VOUCHER });

    assert.equal(answer.code, 200);
    assert.equal(answer.payload.verified, false);
    assert.equal(answer.payload.size, 100);
    assert.equal(answer.payload.archivePath, archives[0]);
    assert.equal(existsSync(archives[0]), true);
    assert.match(answer.payload.output, /size could not be verified/);
    assert.match(answer.payload.output, /Local archive kept at/);
    assert.doesNotMatch(answer.payload.output, /Local archive removed/);
  });

  it('rejects a voucher of the wrong shape without calling the portal', async () => {
    const answer = await call({ voucher: 'GSV-NOPE' });

    assert.equal(answer.code, 400);
    assert.equal(answer.payload.success, false);
    assert.equal(answer.payload.code, 'voucher_format');
    assert.equal(portal.requests.length, 0);
  });

  it('rejects a voucher sent with ticketId or email', async () => {
    const answer = await call({ voucher: VOUCHER, ticketId: 'GSSD-1' });

    assert.equal(answer.code, 400);
    assert.equal(answer.payload.code, 'validation');
    assert.match(answer.payload.error, /voucher/);
    assert.equal(portal.requests.length, 0);
  });

  it('ignores the voucher in local-only mode', async () => {
    const answer = await call({ voucher: 'nonsense', localOnly: true });

    assert.equal(answer.code, 200);
    assert.equal(answer.payload.archivePath, archives[0]);
    assert.equal(answer.payload.uploadedVia, undefined);
    assert.equal(portal.requests.length, 0);
    assert.equal(existsSync(archives[0]), true);
  });

  const refusals: ReadonlyArray<
    readonly [string, number, unknown, number, string, number | undefined]
  > = [
    [
      'an unknown voucher',
      401,
      { error: { code: 'voucher_invalid' } },
      400,
      'voucher_invalid',
      undefined,
    ],
    [
      'an expired voucher',
      410,
      { error: { code: 'voucher_expired' } },
      400,
      'voucher_expired',
      undefined,
    ],
    [
      'a file too large',
      413,
      { error: { code: 'file_too_large', maxBytes: 1234 } },
      400,
      'file_too_large',
      1234,
    ],
    [
      'rate limiting',
      429,
      { error: { code: 'rate_limited' } },
      429,
      'rate_limited',
      undefined,
    ],
  ];

  refusals.forEach(([name, status, body, httpStatus, code, maxBytes]) => {
    it(`answers ${httpStatus} ${code} for ${name} at the check, before collecting anything`, async () => {
      portal.intercept(request =>
        request.path.endsWith('/check') ? { status, body } : undefined,
      );

      const answer = await call({ voucher: VOUCHER });

      assert.equal(answer.code, httpStatus);
      assert.equal(answer.payload.success, false);
      assert.equal(answer.payload.code, code);
      assert.equal(answer.payload.maxBytes, maxBytes);
      assert.equal(answer.payload.error.includes(VOUCHER), false);
      assert.equal(archives.length, 0, 'nothing was collected');
      assert.equal(portal.requests.length, 1);
    });
  });

  it('answers 502 portal_unreachable when the portal cannot be reached', async () => {
    const { url } = portal;
    await portal.close();
    process.env.GLUESYNC_SUPPORT_API_URL = url;

    const answer = await call({ voucher: VOUCHER });

    assert.equal(answer.code, 502);
    assert.equal(answer.payload.code, 'portal_unreachable');
    assert.equal(archives.length, 0);
    // afterEach closes the portal again
    portal = await startFakeSupportPortal();
  });

  it('keeps the archive when the portal refuses it as too large', async () => {
    portal.intercept(request =>
      request.path.endsWith('/check')
        ? {
            status: 200,
            body: { ticketKey: 'GSSD-1234', maxBytes: 100, partBytes: 4096 },
          }
        : undefined,
    );

    const answer = await call({ voucher: VOUCHER });

    assert.equal(answer.code, 400);
    assert.equal(answer.payload.code, 'file_too_large');
    assert.equal(answer.payload.maxBytes, 100);
    assert.equal(
      answer.payload.details,
      `The archive was kept at ${archives[0]}.`,
    );
    assert.equal(existsSync(archives[0]), true);
    assert.equal(portal.calls('/support/log-uploads').length, 0);
  });

  it('keeps the archive and reports a plain failure when the storage refuses it', async () => {
    portal.intercept(request =>
      request.method === 'PUT' ? { status: 400, body: 'bad' } : undefined,
    );

    const answer = await call({ voucher: VOUCHER });

    assert.equal(answer.code, 500);
    assert.equal(answer.payload.success, false);
    assert.equal(answer.payload.code, undefined);
    assert.match(answer.payload.error, /storage refused/);
    assert.match(answer.payload.details, /kept at/);
    assert.equal(existsSync(archives[0]), true);
    assert.equal(portal.calls(/\/abort$/).length, 1);
    assert.equal(doubles.legacyCalls, 0);
    assert.equal(doubles.axiosCalls.length, 0);
  });

  it('never falls back to the legacy script when the archive cannot be created', async () => {
    const base = doubles.script;
    doubles.script = (command, args) =>
      command === 'tar' ? { code: 1 } : base(command, args);

    const answer = await call({ voucher: VOUCHER });

    assert.equal(answer.code, 500);
    assert.equal(answer.payload.success, false);
    assert.equal(answer.payload.code, undefined);
    assert.match(answer.payload.error, /Archive creation failed/);
    assert.equal(doubles.legacyCalls, 0);
    assert.equal(portal.calls('/support/log-uploads').length, 0);
  });

  it('fails when an archive path is missing on the voucher path', async () => {
    const result = internals.createArchiveWithFallback(
      '/nowhere',
      '/nowhere',
      [],
      {
        ticket: '',
        email: '',
        isWindows: false,
        localOnly: false,
        viaPortal: true,
      },
    );

    await assert.rejects(result);
    assert.equal(doubles.legacyCalls, 0);
  });

  it('validates a voucher with the portal, behind a proxy too', async () => {
    process.env.PROXY_HTTPS = 'http://proxy.local:3128';

    const check = await internals.validateCollectLogsInput(
      { localOnly: false, voucher: VOUCHER },
      false,
    );

    assert.equal(check?.ticketKey, 'GSSD-1234');
    assert.equal(doubles.axiosCalls.length, 0);
  });

  it('serves the legacy path unchanged when there is no voucher', async () => {
    process.env.PROXY_HTTPS = 'http://proxy.local:3128';

    const answer = await call({ ticketId: '#1234', email: 'a@b.c' });

    assert.equal(answer.code, 200);
    assert.equal(answer.payload.uploadedVia, 'webdav');
    assert.equal(answer.payload.ticketKey, undefined);
    assert.match(
      answer.payload.output,
      /Archive uploaded successfully via WebDAV/,
    );
    assert.equal(portal.requests.length, 0);
    assert.equal(doubles.axiosCalls.length, 1);
  });

  it('hands the legacy script the normalized ticket key', async () => {
    process.env.PROXY_HTTPS = 'http://proxy.local:3128';
    const base = doubles.script;
    doubles.script = (command, args) =>
      command === 'tar' ? { code: 1 } : base(command, args);

    const answer = await call({ ticketId: '1234', email: 'a@b.c' });

    assert.equal(answer.code, 200);
    assert.deepEqual(doubles.legacyArgs, [
      { ticketId: 'GSSD-1234', email: 'a@b.c' },
    ]);
  });

  it('keeps the legacy errors as they were', async () => {
    const answer = await call({ ticketId: 'GSSD-1' });

    assert.equal(answer.code, 400);
    assert.deepEqual(answer.payload, {
      success: false,
      error: 'ticketId and email are required unless localOnly is true',
    });
  });
});
