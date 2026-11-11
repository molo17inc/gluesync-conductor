import fetchAgentInfo from '../agentInfo/agentInfo';
import { isImageNotPublished } from '../agentInfo/agentInfo.errors';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';
import getCurrentVersion from '../getCurrentVersion/getCurrentVersion';
import { CheckModuleUpdate } from './checkModuleUpdate.model';
import waitForDockerDaemon from '../dockerode/waitForDockerDaemon/waitForDockerDaemon';
import isTransientDockerConnError from '../dockerode/isTransientDockerConnError/isTransientDockerConnError';
import getOrchestrator from '../orchestrator/getOrchestrator/getOrchestrator';
import conductorUpdateRefusal from '../swarm/conductorUpdateRefusal/conductorUpdateRefusal';
import { getLogger } from '../../utils/logger';

const logger = getLogger();

const checkModuleUpdate: CheckModuleUpdate = async (
  docker,
  composeJson,
  releaseChannel,
  serviceName,
) => {
  const services = (composeJson as any).services as
    | Readonly<Record<string, { image?: string }>>
    | undefined;

  const service = services?.[serviceName];

  // Only truly invalid case
  if (!service?.image) {
    return null;
  }

  const dockerReady = await (async () => {
    try {
      await waitForDockerDaemon(docker, logger, {
        totalTimeoutMs: 5000,
        perAttemptTimeoutMs: 800,
      });

      return true;
    } catch (error) {
      if (isTransientDockerConnError(error)) {
        logger.warn(
          { service: serviceName },
          '[checkModuleUpdate] Docker daemon not ready — falling back to compose.yml',
        );

        return false;
      }

      throw error;
    }
  })();

  // Always returns either running tag OR compose fallback
  const {
    shortImageName,
    tag: composeTag,
    interpolatedTag,
  } = parseImage(service.image);
  const currentTag =
    (await getCurrentVersion(docker, composeJson, serviceName, dockerReady)) ||
    composeTag;

  // Compare only semantic version part
  const dashIndex = currentTag.indexOf('-');

  const currentVersion =
    dashIndex !== -1 ? currentTag.slice(0, dashIndex) : currentTag;

  // An image the backoffice does not publish (a custom build) has no update
  // on offer: that is its answer, the rest of the update goes on without it.
  const info = await fetchAgentInfo(shortImageName).catch((error: unknown) => {
    if (isImageNotPublished(error)) {
      logger.warn(
        { service: serviceName, image: shortImageName },
        '[checkModuleUpdate] not published by the backoffice, no update on offer',
      );

      return null;
    }

    throw error;
  });

  if (info === null) {
    return { needsUpdate: false, id: serviceName, availableVersion: null };
  }

  const availableVersion = getVersionByChannel(info, releaseChannel);

  // `image:${TAG}` has no version to compare while nothing runs
  const wantsUpdate =
    !!availableVersion &&
    !(interpolatedTag && !currentVersion) &&
    currentVersion !== availableVersion;

  // The catalog's Conductor may predate Swarm support: a Swarm Conductor never
  // moves to a version that is not newer than itself
  const refusal =
    wantsUpdate &&
    shortImageName === 'conductor' &&
    (await getOrchestrator(docker)).mode === 'swarm'
      ? conductorUpdateRefusal(currentTag, availableVersion)
      : null;

  if (refusal) {
    logger.warn({ service: serviceName, refusal }, '[checkModuleUpdate]');
  }

  return {
    needsUpdate: wantsUpdate && !refusal,
    id: serviceName,
    availableVersion,
    ...(refusal ? { refusal } : {}),
  };
};

export default checkModuleUpdate;
