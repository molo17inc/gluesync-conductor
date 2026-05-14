import fetchAgentInfo from '../agentInfo/agentInfo';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';
import getCurrentVersion from '../getCurrentVersion/getCurrentVersion';
import { CheckModuleUpdate } from './checkModuleUpdate.model';
import waitForDockerDaemon from '../dockerode/waitForDockerDaemon/waitForDockerDaemon';
import isTransientDockerConnError from '../dockerode/isTransientDockerConnError/isTransientDockerConnError';
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
    } catch (err) {
      if (isTransientDockerConnError(err)) {
        logger.warn(
          { service: serviceName },
          '[checkModuleUpdate] Docker daemon not ready — falling back to compose.yml',
        );

        return false;
      }

      throw err;
    }
  })();

  // Always returns either running tag OR compose fallback
  const currentTag =
    (await getCurrentVersion(
      docker,
      composeJson,
      serviceName,
      dockerReady,
    )) || parseImage(service.image).tag;

  const { shortImageName } = parseImage(service.image);

  // Compare only semantic version part
  const dashIndex = currentTag.indexOf('-');

  const currentVersion =
    dashIndex !== -1 ? currentTag.slice(0, dashIndex) : currentTag;

  const info = await fetchAgentInfo(shortImageName);

  const availableVersion = getVersionByChannel(
    info,
    releaseChannel,
  );

  const needsUpdate =
    !!availableVersion &&
    currentVersion !== availableVersion;

  return {
    needsUpdate,
    id: serviceName,
    availableVersion,
  };
};

export default checkModuleUpdate;
