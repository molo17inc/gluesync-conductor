import fs from 'fs';
import path from 'path';
import pino, { Logger, LoggerOptions } from 'pino';
import { createStream, FileSize } from 'rotating-file-stream';

const DEFAULT_LOG_DIR = '/opt/gluesync/logs';
const DEFAULT_LOG_FILENAME = 'gluesync-conductor.log';
const DEFAULT_ROTATION_SIZE = '1G';
const FALLBACK_LOG_DIR = path.resolve(process.cwd(), 'logs');

const resolveConfiguredLogDirectory = (): string | null =>
  process.env.GLUESYNC_LOG_DIR?.trim() || null;

const getCandidateDirectories = (): string[] => {
  const directories = [
    resolveConfiguredLogDirectory(),
    DEFAULT_LOG_DIR,
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
// agent with `user:password` in `proxy.auth` / `proxy.href`. Logging an error
// object (`{ error }`) would write the password to the log files that support
// collects, so those fields are masked wherever an error is logged, also one
// level down (`{ ctx: { error } }`).
const PROXY_SECRETS = ['auth', 'href', 'path'];

export const LOG_REDACTION = {
  paths: ['*', '*.*'].flatMap(prefix =>
    PROXY_SECRETS.map(field => `${prefix}.config.httpsAgent.proxy.${field}`),
  ),
  censor: '[Redacted]',
};

const loggerCache = { current: null as Logger | null };

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

const buildLogger = (): Logger => {
  const directory = ensureLogDirectory();
  const filename = resolveLogFilename();
  const rotationSize = resolveRotationSize();

  const options: LoggerOptions = {
    level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
    timestamp: buildTimestamp,
    redact: LOG_REDACTION,
  };

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

    return pino(options, fileStream);
  } catch (error) {
    console.error(
      `Failed to create rotating file stream at ${directory}/${filename}: ${String(error)}`,
    );
    return pino(options);
  }
};

export const getLogger = (): Logger => {
  if (!loggerCache.current) {
    // eslint-disable-next-line functional/immutable-data
    loggerCache.current = buildLogger();
  }

  return loggerCache.current;
};

export const getLoggerOptions = () => {
  const directory = ensureLogDirectory();
  const filename = resolveLogFilename();
  const rotationSize = resolveRotationSize();

  if (!directory) {
    return {
      level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
      redact: LOG_REDACTION,
    };
  }

  try {
    const fileStream = createStream(filename, {
      size: rotationSize,
      teeToStdout: true,
      path: directory,
    });

    return {
      level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
      redact: LOG_REDACTION,
      stream: fileStream,
    };
  } catch (error) {
    console.error(
      `Failed to create rotating file stream at ${directory}/${filename}: ${String(error)}`,
    );
    return {
      level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
      redact: LOG_REDACTION,
    };
  }
};
