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
import fetchAllArtifactVersions from '../../../helpers/fetchLatestArtifactVersion/fetchLatestArtifactVersion';

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

      try {
        const containers = await req.server.docker.listContainers({
          all: true,
          filters: {
            label: [`${LabelPrefix.COMPOSE}.service=${serviceId}`],
          },
        });

        const running = containers?.find(
          c => (c.State || '').toLowerCase() === 'running',
        );
        if (!running) {
          return fallback();
        }

        const inspect = await req.server.docker
          .getContainer(running.Id)
          .inspect();
        const { tag } = parseImage(inspect.Config.Image);
        return tag.split('-')[0];
      } catch (err) {
        logger.warn(
          { serviceId, err },
          '[get-service-version] Docker inspection failed — fallback to compose.yml',
        );
        return fallback();
      }
    };

    // Fetch all Maven artifact versions once
    const allArtifactVersions = await fetchAllArtifactVersions(channel);

    const needsUpdate = async (serviceId: string): Promise<boolean> => {
      const svc = composeJson.services?.[serviceId];
      if (!svc) {
        return false;
      }

      const {
        imageName,
        shortImageName,
        tag: composeTag,
      } = parseImage(svc.image);

      const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';
      const windowsYear = process.env.WINDOWS_YEAR;

      const { labels } = svc;

      const serviceType = Array.isArray(labels)
        ? labels
            .find(l => l.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
            ?.split('=')[1]
        : labels?.[`${LabelPrefix.CONDUCTOR}.type`];

      const isAgentService = serviceType === 'agent';
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

      // Only check Maven for agents
      const artifactName = isAgentService ? imageName : null;
      const artifact = artifactName
        ? allArtifactVersions.find(a => a.a === artifactName)
        : null;
      const mavenLatestVersion = artifact?.latestVersion;

      const versionToCheck = currentVersion || composeTag.split('-')[0];

      return mavenLatestVersion
        ? mavenLatestVersion !== versionToCheck
        : expectedVersion !== versionToCheck;
    };

    const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
    const conductorName = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
    const chronosName = process.env.CHRONOS_NAME || 'gluesync-chronos';

    const { imageName, shortImageName, tag } = parseImage(service.image);
    const fallbackVersion = tag.split('-')[0];

    logger.info({ id, shortImageName }, 'fetching agent info');

    const mandatoryUpdateResult = await (async () => {
      if (id !== coreHubName) {
        return {
          mandatoryUpdate: false,
          servicesToUpdate: [],
        };
      }

      const thirdPartyServices = Array.from(THIRD_PARTY_SERVICES);

      const servicesToCheck = [
        conductorName,
        chronosName,
        ...thirdPartyServices,
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

    // Determine currentVersion for the requested service
    const [currentVersion, serviceInfo] = await Promise.all([
      getCurrentVersion(id),
      fetchAgentInfo(shortImageName),
    ]);

    const expectedVersion = getVersionByChannel(serviceInfo, channel);

    // Only check Maven for agents
    const serviceType = Array.isArray(service.labels)
      ? service.labels
          .find(l => l.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
          ?.split('=')[1]
      : service.labels?.[`${LabelPrefix.CONDUCTOR}.type`];

    const isAgentService = serviceType === 'agent';
    const artifactName = isAgentService ? imageName : undefined;
    const artifact = artifactName
      ? allArtifactVersions.find(a => a.a === artifactName)
      : undefined;
    const mavenLatestVersion = artifact?.latestVersion;

    // Determine effective current version
    const effectiveVersion =
      isAgentService &&
      mavenLatestVersion &&
      expectedVersion !== mavenLatestVersion
        ? (logger.warn(
            { id, channel, expectedVersion, mavenLatestVersion },
            '[get-service-version] version mismatch - overriding with Maven latest',
          ),
          mavenLatestVersion)
        : currentVersion || fallbackVersion;

    // Adjust serviceInfo for the requested release channel
    const adjustedServiceInfo = {
      ...serviceInfo,
      latestVersionGA:
        channel === 'ga' ? effectiveVersion : serviceInfo?.latestVersionGA,
      latestVersionBeta:
        channel === 'beta' ? effectiveVersion : serviceInfo?.latestVersionBeta,
      latestVersionAlpha:
        channel === 'alpha'
          ? effectiveVersion
          : serviceInfo?.latestVersionAlpha,
    };

    return reply.send({
      success: true,
      data: {
        currentVersion: effectiveVersion,
        latestVersionAlpha: adjustedServiceInfo.latestVersionAlpha,
        latestVersionBeta: adjustedServiceInfo.latestVersionBeta,
        latestVersionGA: adjustedServiceInfo.latestVersionGA,
        mandatoryUpdate: mandatoryUpdateResult.mandatoryUpdate,
        servicesToUpdate: mandatoryUpdateResult.servicesToUpdate,
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
