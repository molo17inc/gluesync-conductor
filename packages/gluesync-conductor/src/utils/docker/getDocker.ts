import Docker from 'dockerode';
import os from 'os';
import fs from 'fs';
import { getLogger } from '../logger';

/**
 * Factory that creates a fresh Docker client
 * Fully cross‑platform: Windows, macOS, Linux
 */
const createDocker = (): Docker => {
  const logger = getLogger();

  // 1. DOCKER_HOST override
  if (process.env.DOCKER_HOST) {
    logger.info(
      `Using Docker host from environment: ${process.env.DOCKER_HOST}`,
    );
    return new Docker();
  }

  // 2. Windows named pipe
  if (os.platform() === 'win32') {
    logger.info('Using Windows Docker named pipe: \\\\.\\pipe\\docker_engine');
    return new Docker({ socketPath: '\\\\.\\pipe\\docker_engine' });
  }

  // 3. macOS: search multiple possible socket paths
  if (os.platform() === 'darwin') {
    const possibleSocketPaths = [
      '/var/run/docker.sock',
      `${os.homedir()}/Library/Containers/com.docker.docker/Data/docker.sock`,
      '/Users/Shared/docker.sock',
      `${os.homedir()}/.docker/run/docker.sock`,
    ] as const;

    const socketPath = possibleSocketPaths.find(path => fs.existsSync(path));

    if (socketPath) {
      logger.info(`Using Docker socket at: ${socketPath}`);
      return new Docker({ socketPath });
    }

    logger.warn(
      'Could not find Docker socket on macOS, using default configuration',
    );
    return new Docker();
  }

  // 4. Linux default
  const linuxSocket = '/var/run/docker.sock';
  if (fs.existsSync(linuxSocket)) {
    logger.info(`Using default Docker socket path: ${linuxSocket}`);
    return new Docker({ socketPath: linuxSocket });
  }

  // 5. Fallback
  logger.warn('No Docker socket found — using default Dockerode configuration');
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
