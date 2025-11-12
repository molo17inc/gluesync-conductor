import fs from 'fs';
import path from 'path';
import pino, { Logger, LoggerOptions } from 'pino';
import { createStream } from 'rotating-file-stream';

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

const resolveRotationSize = (): string =>
  process.env.GLUESYNC_LOG_ROTATION_SIZE || DEFAULT_ROTATION_SIZE;

let cachedLogger: Logger | null = null;

const ensureLogDirectory = (): string | null => {
  const directories = getCandidateDirectories();

  for (const [index, directory] of directories.entries()) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.accessSync(directory, fs.constants.W_OK);
      if (index > 0) {
        console.warn(`Using fallback log directory: ${directory}`);
      }
      return directory;
    } catch (error) {
      console.error(
        `Failed to prepare log directory at ${directory}: ${String(error)}`,
      );
    }
  }

  return null;
};

const buildLogger = (): Logger => {
  const directory = ensureLogDirectory();
  const filename = resolveLogFilename();
  const rotationSize = resolveRotationSize();

  const options: LoggerOptions = {
    level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
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
  if (!cachedLogger) {
    cachedLogger = buildLogger();
  }

  return cachedLogger;
};

export const createLogger = (): Logger => buildLogger();

export const getLoggerOptions = () => {
  const directory = ensureLogDirectory();
  const filename = resolveLogFilename();
  const rotationSize = resolveRotationSize();

  if (!directory) {
    return {
      level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
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
      stream: fileStream,
    };
  } catch (error) {
    console.error(
      `Failed to create rotating file stream at ${directory}/${filename}: ${String(error)}`,
    );
    return {
      level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
    };
  }
};
