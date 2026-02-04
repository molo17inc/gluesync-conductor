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

const logger = getLogger();

const handler: GetServiceVersionHandler = async (req, reply) => {
  try {
    const { id, releaseChannel } = castObject<GetServiceVersionParams>(
      req.params,
    );

    logger.info(
      { id, releaseChannel },
      '[get-service-version] request received',
    );

    // Default to "ga" if releaseChannel is not provided
    const channel: ReleaseChannelTypes =
      (releaseChannel as ReleaseChannelTypes) || 'ga';

    const composeJson = await readComposeFile();
    const service = composeJson.services?.[id];

    if (!service) {
      logger.warn(
        { id },
        '[get-service-version] service not found in docker compose file',
      );
      return reply.code(404).send({
        success: false,
        error: `Service ${id} not found in docker compose file`,
      });
    }

    // Get actual running version from Docker
    // Get actual running version from Docker, or fallback to compose image tag if no running containers
    const getCurrentVersion = async (
      serviceId: string,
    ): Promise<string | null> => {
      try {
        const containers = await req.server.docker.listContainers({
          all: true,
          filters: {
            label: [`${LabelPrefix.COMPOSE}.service=${serviceId}`],
          },
        });

        // No containers at all for this service -> fallback to compose image tag
        if (!containers || containers.length === 0) {
          logger.info(
            { service: serviceId },
            '[get-service-version] no containers found, using compose tag',
          );
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

        // No running container found -> use compose image tag
        if (!running) {
          logger.info(
            { service: serviceId },
            '[get-service-version] no running container, using compose tag',
          );
          const svc = composeJson.services?.[serviceId];
          if (!svc?.image) {
            return null;
          }
          const { tag } = parseImage(svc.image);
          return tag.split('-')[0];
        }

        // Inspect the running container and parse its image tag
        const inspect = await req.server.docker
          .getContainer(running.Id)
          .inspect();

        const runningImage = inspect.Config.Image;
        const { tag } = parseImage(runningImage);
        return tag.split('-')[0];
      } catch (err) {
        logger.warn(
          { service: serviceId, error: err },
          '[get-service-version] failed to inspect container, falling back',
        );

        try {
          const svc = composeJson.services?.[serviceId];
          if (!svc?.image) {
            return null;
          }
          const { tag } = parseImage(svc.image);
          return tag.split('-')[0];
        } catch {
          return null;
        }
      }
    };

    // Helper to check if a service needs update based on release channel
    const needsUpdate = async (serviceId: string): Promise<boolean> => {
      const svc = composeJson.services?.[serviceId];
      if (!svc) {
        return false;
      }

      const { shortImageName, tag: composeTag } = parseImage(svc.image);

      // Parallelize: fetch service info and current version at the same time
      const [svcInfo, currentVersion] = await Promise.all([
        fetchAgentInfo(shortImageName),
        getCurrentVersion(serviceId),
      ]);

      const expectedVersion = getVersionByChannel(svcInfo, channel);

      // If we can't determine the expected version, assume no update is needed
      if (!expectedVersion) {
        return false;
      }

      // Use running version or fallback to compose file version
      const versionToCheck = currentVersion || composeTag.split('-')[0];

      return expectedVersion !== versionToCheck;
    };

    const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
    const conductorName = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
    const chronosName = process.env.CHRONOS_NAME || 'gluesync-chronos';

    // Parallelize: get current version and check mandatory updates at the same time
    const { shortImageName, tag } = parseImage(service.image);
    const fallbackVersion = tag.split('-')[0];

    logger.info(
      { id, shortImageName },
      '[get-service-version] fetching agent info and versions',
    );

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

          const [
            conductorNeedsUpdate,
            chronosNeedsUpdate,
            ...thirdPartyResults
          ] = results;

          const thirdPartyNeedsUpdate = thirdPartyResults.some(x => x === true);

          return (
            conductorNeedsUpdate || chronosNeedsUpdate || thirdPartyNeedsUpdate
          );
        }
        return false;
      })(),
    ]);

    const actualCurrentVersion = currentVersion || fallbackVersion;

    logger.info(
      {
        id,
        currentVersion: actualCurrentVersion,
        mandatoryUpdate,
      },
      '[get-service-version] version computation complete',
    );

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
    logger.error(
      {
        error,
        message: error instanceof Error ? error.message : String(error),
      },
      '[get-service-version] unexpected error',
    );

    return reply.code(502).send({
      success: false,
      error: 'Unable to retrieve agent version',
      details: `Failed to get agent version: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
};

export default handler;
