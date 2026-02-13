import Docker from 'dockerode';
import os from 'os';
import fs from 'fs';
import { getLogger } from '../logger';

/**
 * Factory that creates a fresh Docker client
 */
const createDocker = (): Docker => {
  const logger = getLogger();

  if (process.env.DOCKER_HOST) {
    logger.info(
      `Using Docker host from environment: ${process.env.DOCKER_HOST}`,
    );
    return new Docker();
  }

  if (os.platform() === 'win32') {
    return new Docker({ socketPath: '\\\\.\\pipe\\docker_engine' });
  }

  const defaultSocket = '/var/run/docker.sock';
  if (fs.existsSync(defaultSocket)) {
    return new Docker({ socketPath: defaultSocket });
  }

  return new Docker();
};

/**
 * Helper to wrap an existing instance immutably
 */
const makeDockerSingletonWithInstance = (docker: Readonly<Docker>) => ({
  get: (): Docker => docker,
  rebuild: (): Docker => makeDockerSingletonWithInstance(createDocker()).get(),
});

/**
 * Pure functional Docker singleton container
 */
export const makeDockerSingleton = () => {
  const instance = createDocker();

  return {
    get: (): Docker => instance,
    rebuild: (): Docker =>
      makeDockerSingletonWithInstance(createDocker()).get(),
  };
};

/**
 * Default singleton
 */
export const dockerSingleton = makeDockerSingleton();

/**
 * Exposed functions
 */
export const getDocker = (): Docker => dockerSingleton.get();
export const rebuildDocker = (): Docker => dockerSingleton.rebuild();
