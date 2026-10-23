import fs from 'fs';
import path from 'path';
import pino, { Logger, LoggerOptions } from 'pino';
import {
  createStream,
  FileSize,
  RotatingFileStream,
} from 'rotating-file-stream';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

// The kits mount ./logs here, so the log survives container recreation
// (updates, restarts) and is picked up by collect-logs.
const MOUNTED_LOG_DIR = isWindows
  ? String.raw`C:\opt\gluesync-conductor\logs`
  : '/opt/gluesync-conductor/logs';
const LEGACY_LOG_DIR = '/opt/gluesync/logs';
const DEFAULT_LOG_FILENAME = 'gluesync-conductor.log';
const DEFAULT_ROTATION_SIZE = '1G';
const FALLBACK_LOG_DIR = path.resolve(process.cwd(), 'logs');

// Values that must never reach a log line.
const REDACT_PATHS = [
  'proxyUrl',
  'proxyObj.auth.password',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'authorizationHeader',
  'cookieHeader',
];

const resolveConfiguredLogDirectory = (): string | null =>
  process.env.GLUESYNC_LOG_DIR?.trim() || null;

const getCandidateDirectories = (): string[] => {
  const directories = [
    resolveConfiguredLogDirectory(),
    MOUNTED_LOG_DIR,
    LEGACY_LOG_DIR,
    FALLBACK_LOG_DIR,
  ].filter(Boolean) as string[];

  return directories.filter(
    (directory, index) => directories.indexOf(directory) === index,
  );
};

const resolveLogFilename = (): string =>
  process.env.GLUESYNC_LOG_FILE || DEFAULT_LOG_FILENAME;

const resolveRotationSize = (): FileSize =>
  (process.env.GLUESYNC_LOG_ROTATION_SIZE || DEFAULT_ROTATION_SIZE) as FileSize;

// An axios error carries its request config, and that config holds the proxy
// agent with `user:password` in `proxy.auth` / `proxy.href`. The `error` and
// `err` serializers drop the config, but an error logged under any other key
// (`{ cause }`, `{ ctx: { error } }`) would write the password to the log files
// that support collects, so those fields are masked one and two levels down.
const PROXY_SECRETS = ['auth', 'href', 'path'];

export const LOG_REDACTION = {
  paths: [
    ...REDACT_PATHS,
    ...['*', '*.*'].flatMap(prefix =>
      PROXY_SECRETS.map(field => `${prefix}.config.httpsAgent.proxy.${field}`),
    ),
  ],
  censor: '[REDACTED]',
};

const loggerCache = {
  current: null as Logger | null,
  stream: null as RotatingFileStream | null,
};

const ensureLogDirectory = (): string | null => {
  const directories = getCandidateDirectories();

  const foundDirectory = directories
    .map((directory, index) => ({ directory, index }))
    .find(({ directory, index }) => {
      try {
        fs.mkdirSync(directory, { recursive: true });
        fs.accessSync(directory, fs.constants.W_OK);
        if (index > 0) {
          console.warn(`Using fallback log directory: ${directory}`);
        }
        return true;
      } catch (error) {
        console.error(
          `Failed to prepare log directory at ${directory}: ${String(error)}`,
        );
        return false;
      }
    });

  return foundDirectory ? foundDirectory.directory : null;
};

/**
 * Format timestamp using LOCAL system timezone only.
 * Matches debug-tz output format: DD/MM/YYYY HH:mm:ss TZ
 */
const buildTimestamp = (): string => {
  const tz = process.env.TZ || undefined;
  const localTime = new Date().toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return `,"time":"${localTime}"`;
};

/**
 * Error objects have no enumerable fields, so `{ error }` used to be logged as
 * `"error":{}`. Keep what explains the failure and drop the rest (an
 * AxiosError carries its whole request config).
 */
export const serializeError = (error: unknown): unknown => {
  if (!(error instanceof Error)) {
    return error;
  }
  const e = error as Error & {
    code?: unknown;
    errno?: unknown;
    response?: { status?: number };
    config?: { url?: string; method?: string };
  };
  return {
    type: e.name,
    message: e.message,
    ...(e.code !== undefined ? { code: e.code } : {}),
    ...(e.errno !== undefined ? { errno: e.errno } : {}),
    ...(e.response?.status !== undefined ? { status: e.response.status } : {}),
    ...(e.config?.url ? { url: e.config.url, method: e.config.method } : {}),
    stack: e.stack,
  };
};

const buildOptions = (): LoggerOptions => ({
  level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  timestamp: buildTimestamp,
  serializers: {
    error: serializeError,
    err: serializeError,
  },
  redact: LOG_REDACTION,
});

const buildLogger = (): Logger => {
  const directory = ensureLogDirectory();
  const filename = resolveLogFilename();
  const rotationSize = resolveRotationSize();
  const options = buildOptions();

  if (!directory) {
    console.error(
      'Unable to access any configured log directory. Logging to stdout only.',
    );
    return pino(options);
  }

  try {
    const fileStream = createStream(filename, {
      size: rotationSize,
      teeToStdout: true,
      path: directory,
    });
    // eslint-disable-next-line functional/immutable-data
    loggerCache.stream = fileStream;

    return pino(options, fileStream);
  } catch (error) {
    console.error(
      `Failed to create rotating file stream at ${directory}/${filename}: ${String(error)}`,
    );
    return pino(options);
  }
};

/**
 * The single logger of the process. Fastify uses it too (loggerInstance), so
 * there is one file stream, one rotation and one timestamp format.
 */
export const getLogger = (): Logger => {
  if (!loggerCache.current) {
    // eslint-disable-next-line functional/immutable-data
    loggerCache.current = buildLogger();
  }

  return loggerCache.current;
};

/**
 * Logs a fatal error and exits once it is written.
 *
 * The file stream is asynchronous, so a bare `process.exit()` right after
 * `logger.error()` loses the line explaining why the process stopped. The
 * line is written synchronously to stderr first (docker logs), then to the
 * file, and the process exits after the stream has had time to flush.
 */
export const logFatalAndExit = (
  msg: string,
  error: unknown,
  exitCode = 1,
): void => {
  const line = JSON.stringify({
    level: 60,
    time: Date.now(),
    pid: process.pid,
    msg,
    error: serializeError(error),
  });
  try {
    fs.writeSync(2, `${line}\n`);
  } catch {
    /* stderr closed: nothing else to try */
  }
  try {
    getLogger().fatal({ error }, msg);
  } catch {
    /* logger unusable: the stderr line above is the record */
  }
  const exit = (): void => process.exit(exitCode);
  const { stream } = loggerCache;
  if (stream && !stream.writableNeedDrain) {
    setTimeout(exit, 250);
  } else if (stream) {
    stream.once('drain', () => setTimeout(exit, 50));
    setTimeout(exit, 2000);
  } else {
    setTimeout(exit, 50);
  }
};
