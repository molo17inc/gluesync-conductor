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
 * Pure functional "once" wrapper
 */
const once = <T>(fn: () => T): (() => T) => {
  const cache = { value: undefined as T | undefined };
  return () => {
    if (cache.value === undefined) {
      cache.value = fn();
    }
    return cache.value;
  };
};

/**
 * Immutable Docker accessors
 */
const getDockerSingleton = once(createDocker);

export const getDocker = (): Docker => getDockerSingleton();

/**
 * Rebuild Docker client (returns new instance and replaces cached one)
 */
export const rebuildDocker = (): Docker => {
  const newDocker = createDocker();
  // Replace the cached singleton
  (getDockerSingleton as any).value = newDocker; // type-safe replacement trick
  return newDocker;
};
