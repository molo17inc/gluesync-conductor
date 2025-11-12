import fs from 'fs';
import pino, { Logger, LoggerOptions } from 'pino';
import { createStream } from 'rotating-file-stream';

const DEFAULT_LOG_DIR = '/opt/gluesync/logs';
const DEFAULT_LOG_FILENAME = 'gluesync-conductor.log';
const DEFAULT_ROTATION_SIZE = '1G';

const resolveLogDirectory = (): string =>
  process.env.GLUESYNC_LOG_DIR || DEFAULT_LOG_DIR;

const resolveLogFilename = (): string =>
  process.env.GLUESYNC_LOG_FILE || DEFAULT_LOG_FILENAME;

const resolveRotationSize = (): string =>
  process.env.GLUESYNC_LOG_ROTATION_SIZE || DEFAULT_ROTATION_SIZE;

let cachedLogger: Logger | null = null;

const ensureLogDirectory = (directory: string): void => {
  if (fs.existsSync(directory)) return;

  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    console.error(
      `Failed to create log directory at ${directory}: ${String(error)}`,
    );
  }
};

const buildLogger = (): Logger => {
  const directory = resolveLogDirectory();
  const filename = resolveLogFilename();
  const rotationSize = resolveRotationSize();

  ensureLogDirectory(directory);

  const options: LoggerOptions = {
    level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  };

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
