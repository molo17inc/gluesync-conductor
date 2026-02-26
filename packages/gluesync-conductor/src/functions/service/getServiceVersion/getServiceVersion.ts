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

    // const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
    const conductorName = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
    const chronosName = process.env.CHRONOS_NAME || 'gluesync-chronos';

    const { shortImageName, tag } = parseImage(service.image);
    const fallbackVersion = tag.split('-')[0];

    logger.info({ id, shortImageName }, 'fetching agent info');

    // Determine currentVersion and agent info
    const [currentVersion, serviceInfo] = await Promise.all([
      getCurrentVersion(id),
      fetchAgentInfo(shortImageName),
    ]);

    /// Determine latestVersion for requested channel
    const latestVersionMap: Record<
      ReleaseChannelTypes,
      'latestVersionAlpha' | 'latestVersionBeta' | 'latestVersionGA'
    > = {
      alpha: 'latestVersionAlpha',
      beta: 'latestVersionBeta',
      ga: 'latestVersionGA',
    };

    const latestVersionKey = latestVersionMap[channel];

    // Gather all agent services
    const agents: Array<{ id: string; image: string }> = Object.entries(
      composeJson.services || {},
    )
      .filter(([, svc]) => {
        const { labels } = svc;
        const serviceType = Array.isArray(labels)
          ? labels
              .find(l => l.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
              ?.split('=')[1]
          : labels?.[`${LabelPrefix.CONDUCTOR}.type`];
        return serviceType === 'agent';
      })
      .map(([id, svc]) => ({ id, image: svc.image }));

    const backofficeVersionForChannel = serviceInfo[latestVersionKey];
    // Determine the appropriate latestVersion for the requested channel
    const updatedServiceInfo = !agents.length
      ? {
          ...serviceInfo,
          [latestVersionKey]: backofficeVersionForChannel,
        }
      : (() => {
          const allAgentsMatchBackoffice = agents.every(agent => {
            const artifact = allArtifactVersions.find(
              a => a.a === parseImage(agent.image).imageName,
            );
            return artifact?.latestVersion === backofficeVersionForChannel;
          });

          if (allAgentsMatchBackoffice) {
            logger.info(
              { latestVersionKey },
              '[get-service-version] all agents match backoffice → using backoffice version',
            );
            return {
              ...serviceInfo,
              [latestVersionKey]: backofficeVersionForChannel,
            };
          }
          logger.warn(
            { latestVersionKey, currentVersion },
            '[get-service-version] agent mismatch → using currentVersion',
          );
          return {
            ...serviceInfo,
            [latestVersionKey]: currentVersion || fallbackVersion,
          };
        })();

    // Determine effectiveVersion for the response
    const effectiveVersion = currentVersion || fallbackVersion;

    // Check modules & third-party services for updates
    const thirdPartyServices = Array.from(THIRD_PARTY_SERVICES);
    const servicesToCheck = [conductorName, chronosName, ...thirdPartyServices];

    const results = await Promise.all(
      servicesToCheck.map(async svcId => {
        try {
          const update = await needsUpdate(svcId);
          return { id: svcId, needsUpdate: update };
        } catch {
          return { id: svcId, needsUpdate: false };
        }
      }),
    );

    const servicesToUpdate = results.filter(r => r.needsUpdate).map(r => r.id);

    // Return response
    return reply.send({
      success: true,
      data: {
        currentVersion: effectiveVersion,
        latestVersionAlpha: updatedServiceInfo.latestVersionAlpha,
        latestVersionBeta: updatedServiceInfo.latestVersionBeta,
        latestVersionGA: updatedServiceInfo.latestVersionGA,
        mandatoryUpdate: servicesToUpdate.length > 0,
        servicesToUpdate,
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
