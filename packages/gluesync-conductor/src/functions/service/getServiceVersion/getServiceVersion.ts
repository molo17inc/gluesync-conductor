import {
  GetServiceVersionHandler,
  GetServiceVersionParams,
} from './getServiceVersion.model';
import { castObject } from '../../../helpers/composeFile/extractKeyValue/extractKeyValue';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import fetchAgentInfo from '../../../helpers/agentInfo/agentInfo';
import parseImage from '../../../helpers/parseImage/parseImage';
import { ReleaseChannelTypes } from '../../../models/conductor.model';
import getVersionByChannel from '../../../helpers/releaseChannel/getVersionByChannel';
import { LabelPrefix } from '../../../models/composeFile.model';
import { THIRD_PARTY_SERVICES } from '../../../helpers/fetchAllServicesInCompose/fetchAllServicesInCompose.model';
import { getLogger } from '../../../utils/logger';
import {
  isTransientDockerConnError,
  waitForDockerDaemon,
} from '../../../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';

const logger = getLogger();

const handler: GetServiceVersionHandler = async (req, reply) => {
  try {
    const { id, releaseChannel } = castObject<GetServiceVersionParams>(
      req.params,
    );

    // Default to "ga" if releaseChannel is not provided
    const channel: ReleaseChannelTypes =
      (releaseChannel as ReleaseChannelTypes) || 'ga';

    const composeJson = await readComposeFile();
    const service = composeJson.services?.[id];

    if (!service) {
      logger.warn({ id }, '[get-service-version] service not found');
      return reply.code(404).send({
        success: false,
        error: `Service ${id} not found in docker compose file`,
      });
    }

    // Ensure docker ready (Windows pipe cold boot fix)
    await waitForDockerDaemon(req.server.docker, req.log, {
      totalTimeoutMs: 5000,
      perAttemptTimeoutMs: 800,
    });

    const getCurrentVersion = async (
      serviceId: string,
    ): Promise<string | null> => {
      const attempt = async (): Promise<string | null> => {
        const containers = await req.server.docker.listContainers({
          all: true,
          filters: {
            label: [`${LabelPrefix.COMPOSE}.service=${serviceId}`],
          },
        });

        if (!containers || containers.length === 0) {
          const svc = composeJson.services?.[serviceId];
          if (!svc?.image) {
            return null;
          }
          const { tag } = parseImage(svc.image);
          return tag.split('-')[0];
        }

        const running = containers.find(
          c => (c.State || '').toLowerCase() === 'running',
        );

        if (!running) {
          const svc = composeJson.services?.[serviceId];
          if (!svc?.image) {
            return null;
          }
          const { tag } = parseImage(svc.image);
          return tag.split('-')[0];
        }

        const inspect = await req.server.docker
          .getContainer(running.Id)
          .inspect();

        const runningImage = inspect.Config.Image;
        const { tag } = parseImage(runningImage);
        return tag.split('-')[0];
      };

      try {
        return await attempt();
      } catch (err) {
        if (isTransientDockerConnError(err)) {
          logger.warn(
            { service: serviceId },
            '[get-service-version] docker pipe busy — retrying',
          );

          await waitForDockerDaemon(req.server.docker, req.log, {
            totalTimeoutMs: 4000,
            perAttemptTimeoutMs: 800,
          });

          return attempt();
        }

        logger.warn({ service: serviceId, err }, 'inspect failed fallback');

        const svc = composeJson.services?.[serviceId];
        if (!svc?.image) {
          return null;
        }
        const { tag } = parseImage(svc.image);
        return tag.split('-')[0];
      }
    };

    const needsUpdate = async (serviceId: string): Promise<boolean> => {
      const svc = composeJson.services?.[serviceId];
      if (!svc) {
        return false;
      }

      const { shortImageName, tag: composeTag } = parseImage(svc.image);

      const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';
      const windowsYear = process.env.WINDOWS_YEAR;

      const { labels } = svc;

      const serviceType = Array.isArray(labels)
        ? labels
            .find(l => l.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
            ?.split('=')[1]
        : labels?.[`${LabelPrefix.CONDUCTOR}.type`];

      const isThirdParty = serviceType === 'third-party';

      // Build correct imageName for backoffice API
      const imageNameToFetch =
        isWindows && isThirdParty && windowsYear
          ? `${shortImageName}-win-${windowsYear}`
          : shortImageName;

      const [svcInfo, currentVersion] = await Promise.all([
        fetchAgentInfo(imageNameToFetch),
        getCurrentVersion(serviceId),
      ]);

      const expectedVersion = getVersionByChannel(svcInfo, channel);
      if (!expectedVersion) {
        return false;
      }

      const versionToCheck = currentVersion || composeTag.split('-')[0];
      return expectedVersion !== versionToCheck;
    };

    const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
    const conductorName = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
    const chronosName = process.env.CHRONOS_NAME || 'gluesync-chronos';

    const { shortImageName, tag } = parseImage(service.image);
    const fallbackVersion = tag.split('-')[0];

    logger.info({ id, shortImageName }, 'fetching agent info');

    const [currentVersion, serviceInfo, mandatoryUpdate] = await Promise.all([
      getCurrentVersion(id),
      fetchAgentInfo(shortImageName),
      (async () => {
        if (id === coreHubName) {
          const thirdPartyServices = Array.from(THIRD_PARTY_SERVICES);

          const results = await Promise.all([
            needsUpdate(conductorName),
            needsUpdate(chronosName),
            ...thirdPartyServices.map(needsUpdate),
          ]);

          return results.some(Boolean);
        }

        return false;
      })(),
    ]);

    const actualCurrentVersion = currentVersion || fallbackVersion;

    return reply.send({
      success: true,
      data: {
        currentVersion: actualCurrentVersion,
        latestVersionAlpha: serviceInfo?.latestVersionAlpha,
        latestVersionBeta: serviceInfo?.latestVersionBeta,
        latestVersionGA: serviceInfo?.latestVersionGA,
        mandatoryUpdate,
      },
    });
  } catch (error: unknown) {
    logger.error({ error }, '[get-service-version] unexpected error');

    if (isTransientDockerConnError(error)) {
      return reply.code(503).send({
        success: false,
        error: 'Docker daemon not ready yet',
        details: error instanceof Error ? error.message : String(error),
      });
    }

    return reply.code(502).send({
      success: false,
      error: 'Unable to retrieve agent version',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
