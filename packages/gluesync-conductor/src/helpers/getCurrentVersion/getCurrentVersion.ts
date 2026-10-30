import parseImage from '../parseImage/parseImage';
import { canonicalImageName } from '../containerRuntime/canonicalImage';
import { LabelPrefix } from '../../models/composeFile.model';
import isTransientDockerConnError from '../dockerode/isTransientDockerConnError/isTransientDockerConnError';
import { getLogger } from '../../utils/logger';
import getOrchestrator from '../orchestrator/getOrchestrator/getOrchestrator';
import getService from '../swarm/getService/getService';
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

  // The tag the service spec asks for, which is what Swarm runs or is about
  // to run (a rolling update changes it before the first new task is up)
  const swarmTag = async (namespace: string): Promise<string | null> => {
    try {
      const { image } = await getService(docker, `${namespace}_${serviceId}`);

      return parseImage(image).tag || fallback();
    } catch (error) {
      if ((error as { statusCode?: number })?.statusCode === 404) {
        return fallback();
      }

      throw error;
    }
  };

  const attempt = async (): Promise<string | null> => {
    const orchestrator = await getOrchestrator(docker);

    if (orchestrator.mode === 'swarm') {
      return swarmTag(orchestrator.namespace);
    }

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
    const runningImage = canonicalImageName(inspect.Config.Image);

    const { tag } = parseImage(runningImage);
    return tag; // FULL TAG — do NOT truncate
  };

  try {
    return await attempt();
  } catch (error) {
    if (isTransientDockerConnError(error)) {
      logger.warn(
        { service: serviceId },
        '[getCurrentVersion] docker unreachable — falling back to compose.yml',
      );
      return fallback();
    }

    logger.warn(
      { service: serviceId, error },
      '[getCurrentVersion] unexpected error — falling back to compose.yml',
    );
    return fallback();
  }
};

export default getCurrentVersion;
