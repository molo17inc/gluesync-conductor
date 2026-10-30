import Docker from 'dockerode';
import os from 'os';
import fs from 'fs';
import { getLogger } from '../logger';

/**
 * Options for a `CONTAINER_HOST` (the variable Podman's own tools read):
 * `unix:///run/podman/podman.sock`, `tcp://host:port`, or a bare socket path.
 * Undefined for what dockerode cannot talk to (`ssh://`).
 */
export const dockerOptionsFromContainerHost = (
  containerHost: string,
): Docker.DockerOptions | undefined => {
  const value = containerHost.trim();

  if (value.startsWith('/')) {
    return { socketPath: value };
  }

  if (value.startsWith('unix://')) {
    return { socketPath: value.slice('unix://'.length) };
  }

  const match = /^(tcp|http|https):\/\/([^/:]+)(?::(\d+))?/.exec(value);

  if (!match) {
    return undefined;
  }

  const [, scheme, host, port] = match;
  const protocol = scheme === 'https' ? 'https' : 'http';
  const defaultPort = protocol === 'https' ? 2376 : 2375;

  return {
    host,
    port: port ? Number.parseInt(port, 10) : defaultPort,
    protocol,
  };
};

/**
 * Where an engine socket can be on a Linux host: Docker's, Podman's rootful
 * one, and Podman's rootless one under the user's runtime directory.
 */
export const linuxSocketCandidates = (
  env: Readonly<NodeJS.ProcessEnv>,
): ReadonlyArray<string> => [
  '/var/run/docker.sock',
  '/run/podman/podman.sock',
  ...(env.XDG_RUNTIME_DIR ? [`${env.XDG_RUNTIME_DIR}/podman/podman.sock`] : []),
];

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

  // 1b. CONTAINER_HOST override (Podman)
  if (process.env.CONTAINER_HOST) {
    const options = dockerOptionsFromContainerHost(process.env.CONTAINER_HOST);

    if (options) {
      logger.info('Using container engine host from CONTAINER_HOST');
      return new Docker(options);
    }

    logger.warn(
      'CONTAINER_HOST is not a unix:// or tcp:// address: ignoring it',
    );
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

  // 4. Linux: Docker's socket (always the one inside a container), else
  // Podman's, rootful then rootless
  const linuxSocket = linuxSocketCandidates(process.env).find(path =>
    fs.existsSync(path),
  );
  if (linuxSocket) {
    logger.info(`Using container engine socket at: ${linuxSocket}`);
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
