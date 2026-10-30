import type Docker from 'dockerode';

import { getDocker } from '../../utils/docker/getDocker';
import { getLogger } from '../../utils/logger';
import { inspectSelf } from '../orchestrator/getOrchestrator/getOrchestrator';

/** Where the engine socket is inside every container, and on a Docker host. */
export const ENGINE_SOCKET_IN_CONTAINER = '/var/run/docker.sock';

// A socket that accepts and never answers must not hold a compose command back
const INSPECT_TIMEOUT_MS = 3000;

const cache = new Map<string, string>();

export const resetHostSocketPathCache = (): void => {
  cache.clear();
};

const mountedSocketSource = async (
  docker: Readonly<Docker>,
): Promise<string | undefined> => {
  // eslint-disable-next-line functional/no-let -- cleared once the race is over
  let timer: NodeJS.Timeout | undefined;
  const inspect = await Promise.race([
    inspectSelf(docker),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('inspect of this container timed out')),
        INSPECT_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));

  return inspect?.Mounts?.find(
    mount => mount?.Destination === ENGINE_SOCKET_IN_CONTAINER,
  )?.Source?.trim();
};

/**
 * The path of the engine socket on the HOST: the `-v` source of a helper
 * container is resolved by the host's engine, not inside this container. It is
 * the `GS_CONTAINER_SOCKET` of the environment (the kit `.env`), else the source
 * of the bind mount this very container has on the socket (Podman: its own
 * `/run/podman/podman.sock` or `/run/user/<uid>/podman/podman.sock`), else
 * `/var/run/docker.sock`. It never throws: an engine that cannot be asked
 * answers with the Docker default.
 */
export const resolveHostSocketPath = async (
  docker: Readonly<Docker> = getDocker(),
): Promise<string> => {
  const configured = process.env.GS_CONTAINER_SOCKET?.trim();

  if (configured) {
    return configured;
  }

  const cached = cache.get('value');

  if (cached) {
    return cached;
  }

  try {
    // Remembered also when there is no mount: the answer does not change
    const resolved =
      (await mountedSocketSource(docker)) || ENGINE_SOCKET_IN_CONTAINER;

    cache.set('value', resolved);

    return resolved;
  } catch (error) {
    getLogger().warn(
      { error },
      '[container-engine] could not read the socket mount of this container: using the Docker default',
    );
  }

  return ENGINE_SOCKET_IN_CONTAINER;
};
