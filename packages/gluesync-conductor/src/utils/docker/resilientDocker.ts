import Docker from 'dockerode';
import { FastifyLoggerInstance } from 'fastify';
import os from 'os';
import fs from 'fs';
import { getLogger } from '../logger';

let docker: Docker | null = null;

/**
 * Rebuilds Docker client (for Windows pipe EOF issues)
 */
export const rebuildDocker = (): Docker => {
  const logger = getLogger();

  try {
    if (process.env.DOCKER_HOST) {
      logger.info(
        `Using Docker host from environment: ${process.env.DOCKER_HOST}`,
      );
      docker = new Docker();
    } else if (os.platform() === 'win32') {
      // Use named pipe
      docker = new Docker({ socketPath: '\\\\.\\pipe\\docker_engine' });
    } else {
      // macOS / Linux fallback
      const defaultSocket = '/var/run/docker.sock';
      docker = fs.existsSync(defaultSocket)
        ? new Docker({ socketPath: defaultSocket })
        : new Docker();
    }
    return docker;
  } catch (err) {
    logger.error(
      `Failed to rebuild Docker client: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
};

/**
 * Returns a valid Docker client, rebuilds if null
 */
export const getDocker = (): Docker => {
  if (!docker) {
    docker = rebuildDocker();
  }
  return docker;
};
