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
import waitForDockerDaemon from '../../../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';
import isTransientDockerConnError from '../../../helpers/dockerode/isTransientDockerConnError/isTransientDockerConnError';
import fetchChangelogInfo from '../../../helpers/fetchChangelogInfo/fetchChangelogInfo';

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
    const dockerReady = await (async () => {
      try {
        await waitForDockerDaemon(req.server.docker, logger, {
          totalTimeoutMs: 5000,
          perAttemptTimeoutMs: 800,
        });
        return true;
      } catch (err) {
        if (isTransientDockerConnError(err)) {
          req.log.warn(
            '[get-service-version] Docker daemon not ready — falling back to compose.yml',
          );
          return false;
        }
        throw err;
      }
    })();

    const getCurrentVersion = async (
      serviceId: string,
    ): Promise<string | null> => {
      const fallback = (): string | null => {
        const svc = composeJson.services?.[serviceId];
        if (!svc?.image) {
          return null;
        }
        const { tag } = parseImage(svc.image);
        return tag.split('-')[0];
      };

      // If Docker never became ready, skip Docker and use docker-compose file
      if (!dockerReady) {
        return fallback();
      }

      const attempt = async (): Promise<string | null> => {
        const containers = await req.server.docker.listContainers({
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
            '[get-service-version] docker unreachable — falling back to compose.yml',
          );
          return fallback();
        }

        logger.warn(
          { service: serviceId, err },
          '[get-service-version] unexpected error — falling back to compose.yml',
        );
        return fallback();
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

    const mandatoryUpdateResult = await (async () => {
      if (id !== coreHubName) {
        return {
          mandatoryUpdate: false,
          servicesToUpdate: [],
        };
      }

      const discoveredModules = Object.keys(composeJson.services || {}).filter(
        svcId => {
          const svc = composeJson.services?.[svcId];
          const labels = svc?.labels;
          const serviceType = Array.isArray(labels)
            ? labels
                .find(l => l.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
                ?.split('=')[1]
            : labels?.[`${LabelPrefix.CONDUCTOR}.type`];
          return serviceType === 'module';
        },
      );

      // exclude conductor and chronos so their logic remains separate
      const otherModuleServices = discoveredModules.filter(
        svcId => svcId !== conductorName && svcId !== chronosName,
      );

      const thirdPartyServices = Array.from(THIRD_PARTY_SERVICES);

      // build final list to check
      const servicesToCheck = [
        conductorName,
        chronosName,
        ...thirdPartyServices,
        ...otherModuleServices,
      ];

      const results = await Promise.all(
        servicesToCheck.map(async svcId => {
          try {
            const update = await needsUpdate(svcId);
            return { id: svcId, needsUpdate: update };
          } catch (err) {
            logger.warn(
              { service: svcId, err },
              '[get-service-version] needsUpdate failed',
            );
            return { id: svcId, needsUpdate: false };
          }
        }),
      );

      const servicesToUpdate = results
        .filter(r => r.needsUpdate)
        .map(r => r.id);

      return {
        mandatoryUpdate: servicesToUpdate.length > 0,
        servicesToUpdate,
      };
    })();

    const [currentVersion, serviceInfo] = await Promise.all([
      getCurrentVersion(id),
      fetchAgentInfo(shortImageName),
    ]);

    const actualCurrentVersion = currentVersion || fallbackVersion;

    const expectedVersion = getVersionByChannel(serviceInfo, channel);

    const changelogResult = expectedVersion
      ? await fetchChangelogInfo(shortImageName, expectedVersion)
      : null;

    return reply.send({
      success: true,
      data: {
        currentVersion: actualCurrentVersion,
        latestVersionAlpha: serviceInfo?.latestVersionAlpha,
        latestVersionBeta: serviceInfo?.latestVersionBeta,
        latestVersionGA: serviceInfo?.latestVersionGA,
        mandatoryUpdate: mandatoryUpdateResult.mandatoryUpdate,
        servicesToUpdate: mandatoryUpdateResult.servicesToUpdate,
        changelogData: changelogResult?.success
          ? changelogResult.data
          : undefined,
      },
    });
  } catch (error: unknown) {
    logger.error({ error }, '[get-service-version] unexpected error');

    return reply.code(502).send({
      success: false,
      error: 'Unable to retrieve agent version',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
