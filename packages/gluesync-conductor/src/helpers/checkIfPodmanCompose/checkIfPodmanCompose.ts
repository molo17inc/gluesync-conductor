import { getLogger } from '../../utils/logger';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';

/**
 * Returns true if the service uses the Podman socket:
 *   /run/podman/podman.sock:/var/run/docker.sock
 */
const checkIfPodmanCompose = async (): Promise<boolean> => {
  const logger = getLogger();
  const conductorServiceName =
    process.env.CONDUCTOR_NAME || 'gluesync-conductor';

  const composeJson = await readComposeFile({ raw: true });

  const service = composeJson.services?.[conductorServiceName];
  if (!service) {
    logger.info('[conductor-checkIfPodmanCompose] service not found');
    return false;
  }

  if (!Array.isArray(service.volumes)) {
    return false;
  }

  const normalize = (v: string): string =>
    v
      .trim()
      .replace(/^"+|"+$/g, '')
      .replace(/\\+/g, '/')
      .replace(/\/+/g, '/')
      .toLowerCase();

  const PODMAN_SOCKET = normalize(
    '/run/podman/podman.sock:/var/run/docker.sock',
  );

  const isPodmanSocket = (v: string) => normalize(v) === PODMAN_SOCKET;

  return service.volumes
    .filter((v): v is string => typeof v === 'string')
    .some(isPodmanSocket);
};

export default checkIfPodmanCompose;
