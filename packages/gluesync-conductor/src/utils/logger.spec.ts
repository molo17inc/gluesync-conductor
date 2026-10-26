import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import loadWithStubs from '../testing/loadWithStubs';
import { serializeError } from './logger';

type LoggerModule = typeof import('./logger');

type Fakes = Readonly<{
  /** directories for which mkdirSync fails */
  badDirs?: ReadonlyArray<string>;
  /** createStream throws */
  streamFails?: boolean;
  /** the file stream reports a full buffer */
  needDrain?: boolean;
  writeSyncFails?: boolean;
  fatalFails?: boolean;
}>;

const load = (fakes: Fakes = {}) => {
  const calls = {
    mkdir: [] as string[],
    created: [] as unknown[],
    pino: [] as unknown[][],
    stderr: [] as string[],
    fatal: [] as unknown[][],
  };
  const stream = Object.assign(new EventEmitter(), {
    writableNeedDrain: fakes.needDrain ?? false,
  });
  const fakePino = (...args: unknown[]) => {
    calls.pino.push(args);
    return {
      fatal: (...a: unknown[]) => {
        if (fakes.fatalFails) {
          throw new Error('logger broken');
        }
        calls.fatal.push(a);
      },
    };
  };
  const mod = loadWithStubs<LoggerModule>(path.resolve(__dirname, './logger'), {
    fs: {
      default: {
        constants: { W_OK: 2 },
        mkdirSync: (dir: string) => {
          calls.mkdir.push(dir);
          if (fakes.badDirs?.includes(dir)) {
            throw new Error(`EACCES ${dir}`);
          }
        },
        accessSync: () => undefined,
        writeSync: (_fd: number, line: string) => {
          if (fakes.writeSyncFails) {
            throw new Error('EBADF');
          }
          calls.stderr.push(line);
        },
      },
    },
    pino: fakePino,
    'rotating-file-stream': {
      createStream: (...args: unknown[]) => {
        if (fakes.streamFails) {
          throw new Error('stream refused');
        }
        calls.created.push(args);
        return stream;
      },
    },
  });
  return { mod, calls, stream };
};

const envKeys = [
  'GLUESYNC_LOG_DIR',
  'GLUESYNC_LOG_FILE',
  'GLUESYNC_LOG_ROTATION_SIZE',
  'LOG_LEVEL',
] as const;
const savedEnv = new Map<string, string | undefined>();
const restoreEnv = (): void => {
  envKeys.forEach(key => {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
};

describe('serializeError', () => {
  it('keeps the message of an Error (it used to be logged as {})', () => {
    const out = serializeError(
      Object.assign(new Error('boom'), { code: 'ECONNRESET' }),
    ) as Record<string, unknown>;
    assert.equal(out.message, 'boom');
    assert.equal(out.code, 'ECONNRESET');
    assert.equal(out.type, 'Error');
    assert.equal(typeof out.stack, 'string');
  });

  it('keeps status and url of an HTTP error without its request config', () => {
    const error = Object.assign(
      new Error('Request failed with status code 404'),
      {
        response: { status: 404 },
        config: {
          url: 'https://api.example/x',
          method: 'get',
          headers: { Authorization: 'Bearer secret' },
        },
      },
    );
    const out = serializeError(error) as Record<string, unknown>;
    assert.equal(out.status, 404);
    assert.equal(out.url, 'https://api.example/x');
    assert.equal(JSON.stringify(out).includes('secret'), false);
  });

  it('passes non-errors through', () => {
    assert.deepEqual(serializeError({ exitCode: 1 }), { exitCode: 1 });
  });
});

describe('getLogger', () => {
  beforeEach(() => {
    envKeys.forEach(key => savedEnv.set(key, process.env[key]));
    process.env.GLUESYNC_LOG_DIR = '/configured/logs';
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'error', () => undefined);
  });
  afterEach(() => {
    restoreEnv();
    mock.restoreAll();
  });

  it('writes to a rotating file in the configured directory and is a singleton', () => {
    process.env.GLUESYNC_LOG_FILE = 'x.log';
    process.env.GLUESYNC_LOG_ROTATION_SIZE = '5M';
    process.env.LOG_LEVEL = 'DEBUG';
    const { mod, calls, stream } = load();
    const logger = mod.getLogger();
    assert.equal(mod.getLogger(), logger);
    assert.deepEqual(calls.created, [
      ['x.log', { size: '5M', teeToStdout: true, path: '/configured/logs' }],
    ]);
    assert.equal(calls.pino.length, 1);
    const [options, target] = calls.pino[0] as [
      { level: string; redact: { paths: string[] } },
      unknown,
    ];
    assert.equal(options.level, 'debug');
    assert.ok(options.redact.paths.includes('req.headers.authorization'));
    assert.equal(target, stream);
  });

  it('falls back to the next writable directory and says so', () => {
    const { mod, calls } = load({ badDirs: ['/configured/logs'] });
    mod.getLogger();
    const [, opts] = calls.created[0] as [string, { path: string }];
    assert.notEqual(opts.path, '/configured/logs');
    assert.equal(calls.mkdir[0], '/configured/logs');
    assert.equal((console.warn as any).mock.callCount(), 1);
    assert.match(
      (console.warn as any).mock.calls[0].arguments[0],
      /Using fallback log directory/,
    );
    assert.equal((console.error as any).mock.callCount(), 1);
  });

  it('logs to stdout only when no directory is writable', () => {
    const { mod, calls } = load({
      badDirs: [
        '/configured/logs',
        '/opt/gluesync-conductor/logs',
        '/opt/gluesync/logs',
        path.resolve(process.cwd(), 'logs'),
      ],
    });
    mod.getLogger();
    assert.equal(calls.created.length, 0);
    assert.equal(calls.pino.length, 1);
    assert.equal(calls.pino[0].length, 1);
    assert.match(
      (console.error as any).mock.calls.at(-1).arguments[0],
      /Unable to access any configured log directory/,
    );
  });

  it('logs to stdout only when the rotating stream cannot be created', () => {
    const { mod, calls } = load({ streamFails: true });
    mod.getLogger();
    assert.equal(calls.pino.length, 1);
    assert.equal(calls.pino[0].length, 1);
    assert.match(
      (console.error as any).mock.calls.at(-1).arguments[0],
      /Failed to create rotating file stream at \/configured\/logs\/gluesync-conductor\.log/,
    );
  });
});

describe('logFatalAndExit', () => {
  beforeEach(() => {
    envKeys.forEach(key => savedEnv.set(key, process.env[key]));
    process.env.GLUESYNC_LOG_DIR = '/configured/logs';
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'error', () => undefined);
    mock.method(process, 'exit', () => undefined);
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
    restoreEnv();
    mock.restoreAll();
  });

  const exits = (): number => (process.exit as any).mock.callCount();

  it('writes the record to stderr and the log, then exits after the flush delay', () => {
    const { mod, calls } = load();
    mod.logFatalAndExit('Cannot start', new Error('boom'), 3);
    assert.equal(calls.stderr.length, 1);
    const record = JSON.parse(calls.stderr[0]);
    assert.equal(record.msg, 'Cannot start');
    assert.equal(record.level, 60);
    assert.equal(record.error.message, 'boom');
    assert.equal(calls.fatal.length, 1);
    assert.equal(exits(), 0);
    mock.timers.tick(249);
    assert.equal(exits(), 0);
    mock.timers.tick(1);
    assert.deepEqual((process.exit as any).mock.calls[0].arguments, [3]);
  });

  it('waits for the stream to drain when its buffer is full', () => {
    const { mod, stream } = load({ needDrain: true });
    mod.logFatalAndExit('Cannot start', 'plain failure');
    mock.timers.tick(100);
    assert.equal(exits(), 0);
    stream.emit('drain');
    mock.timers.tick(49);
    assert.equal(exits(), 0);
    mock.timers.tick(1);
    assert.equal(exits(), 1);
    assert.deepEqual((process.exit as any).mock.calls[0].arguments, [1]);
  });

  it('exits anyway after 2s when the stream never drains', () => {
    const { mod } = load({ needDrain: true });
    mod.logFatalAndExit('Cannot start', undefined);
    mock.timers.tick(2000);
    assert.equal(exits(), 1);
  });

  it('exits quickly when there is no file stream', () => {
    const { mod } = load({ streamFails: true });
    mod.logFatalAndExit('Cannot start', new Error('boom'));
    mock.timers.tick(49);
    assert.equal(exits(), 0);
    mock.timers.tick(1);
    assert.equal(exits(), 1);
  });

  it('still exits when stderr and the logger are both unusable', () => {
    const { mod, calls } = load({ writeSyncFails: true, fatalFails: true });
    mod.logFatalAndExit('Cannot start', new Error('boom'));
    assert.equal(calls.stderr.length, 0);
    assert.equal(calls.fatal.length, 0);
    mock.timers.tick(250);
    assert.equal(exits(), 1);
  });
});
