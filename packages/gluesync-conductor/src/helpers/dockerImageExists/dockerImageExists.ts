import type Docker from 'dockerode';
import { getDocker } from '../../utils/docker/getDocker';

export type DockerImageExists = (
  image: string,
  options?: Readonly<{ docker?: Readonly<Docker>; timeoutMs?: number }>,
) => Promise<boolean>;

const DEFAULT_TIMEOUT_MS = 10_000;

// The timer is cleared as soon as the lookup settles, so it never keeps the
// process alive
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  const timer: { id?: NodeJS.Timeout } = {};

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      // eslint-disable-next-line functional/immutable-data -- handle needed to clear the timer
      timer.id = setTimeout(
        () => reject(new Error(`Timeout after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer.id));
};

/**
 * Whether `image` (name:tag) can be used on this host, asked to the Docker
 * daemon itself: present locally (offline installs load images into the
 * daemon) or, failing that, known to its registry. The registry lookup goes
 * through the daemon (`GET /distribution/{name}/json`), so the daemon's proxy,
 * mirror and credentials apply and no image is pulled.
 *
 * Any error (daemon down, registry unreachable, unknown tag, timeout) means
 * "does not exist": callers keep the image they have.
 */
const dockerImageExists: DockerImageExists = async (
  image,
  { docker = getDocker(), timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) => {
  const found = async (lookup: () => Promise<unknown>): Promise<boolean> => {
    try {
      await withTimeout(lookup(), timeoutMs);
      return true;
    } catch {
      return false;
    }
  };

  return (
    (await found(() => docker.getImage(image).inspect())) ||
    found(() => docker.getImage(image).distribution())
  );
};

export default dockerImageExists;
