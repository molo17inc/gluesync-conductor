import parseImage from '../parseImage/parseImage';
import { LabelPrefix } from '../../models/composeFile.model';
import isTransientDockerConnError from '../dockerode/isTransientDockerConnError/isTransientDockerConnError';
import { getLogger } from '../../utils/logger';
import { GetCurrentVersion } from './getCurrentVersion.model';

const logger = getLogger();

const getCurrentVersion: GetCurrentVersion = async (
  docker,
  composeJson,
  serviceId,
  dockerReady,
) => {
  const fallback = (): string | null => {
    const svc = composeJson.services?.[serviceId];
    if (!svc?.image) {
      return null;
    }

    const { tag } = parseImage(svc.image);
    return tag;
  };

  if (!dockerReady) {
    return fallback();
  }

  const attempt = async (): Promise<string | null> => {
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`${LabelPrefix.COMPOSE}.service=${serviceId}`],
      },
    });

    if (!containers || containers.length === 0) {
      return fallback();
    }

    const running = containers.find(
      c => (c.State || '').toLowerCase() === 'running',
    );

    if (!running) {
      return fallback();
    }

    const inspect = await docker.getContainer(running.Id).inspect();
    const runningImage = inspect.Config.Image;

    const { tag } = parseImage(runningImage);
    return tag; // FULL TAG — do NOT truncate
  };

  try {
    return await attempt();
  } catch (err) {
    if (isTransientDockerConnError(err)) {
      logger.warn(
        { service: serviceId },
        '[getCurrentVersion] docker unreachable — falling back to compose.yml',
      );
      return fallback();
    }

    logger.warn(
      { service: serviceId, err },
      '[getCurrentVersion] unexpected error — falling back to compose.yml',
    );
    return fallback();
  }
};

export default getCurrentVersion;
