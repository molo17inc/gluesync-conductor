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
      return reply.code(404).send({
        success: false,
        error: `Service ${id} not found in docker file`,
      });
    }

    // Get actual running version from Docker
    // Get actual running version from Docker, or fallback to compose image tag if no running container
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
          req.log.info(
            { service: serviceId },
            'No containers found for service, using compose image tag as fallback',
          );
          const svc = composeJson.services?.[serviceId];
          if (!svc?.image) {
            return null;
          }
          const { tag: composeTag } = parseImage(svc.image);
          return composeTag.split('-')[0];
        }

        // Prefer a running container (normalize State)
        const running = containers.find(
          c => (c.State || '').toLowerCase() === 'running',
        );

        if (!running) {
          // No running container found -> use compose image tag as requested
          req.log.info(
            { service: serviceId },
            'No running container found, using compose image tag as fallback',
          );
          const svc = composeJson.services?.[serviceId];
          if (!svc?.image) {
            return null;
          }
          const { tag: composeTag } = parseImage(svc.image);
          return composeTag.split('-')[0];
        }

        // Inspect the running container and parse its image tag
        const inspect = await req.server.docker
          .getContainer(running.Id)
          .inspect();
        const runningImage = inspect.Config.Image;
        const { tag } = parseImage(runningImage);
        return tag.split('-')[0];
      } catch (err) {
        req.log.warn(
          { service: serviceId, error: err },
          `Failed to get running version for ${serviceId}, falling back to compose file`,
        );
        // On any unexpected error, fall back to compose file if possible
        try {
          const svc = composeJson.services?.[serviceId];
          if (!svc?.image) {
            return null;
          }
          const { tag: composeTag } = parseImage(svc.image);
          return composeTag.split('-')[0];
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
    req.log.error(
      `Error getting agent version: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    if (error instanceof Error && (error as any).statusCode === 404) {
      return reply.code(404).send({
        success: false,
        error: 'Service not found',
      });
    }

    return reply.code(500).send({
      success: false,
      error: `Failed to get agent version: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
};

export default handler;
