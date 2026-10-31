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
import { ComposeService, LabelPrefix } from '../../../models/composeFile.model';
import getOrchestrator from '../../../helpers/orchestrator/getOrchestrator/getOrchestrator';
import conductorUpdateRefusal from '../../../helpers/swarm/conductorUpdateRefusal/conductorUpdateRefusal';
import stackServiceType from '../../../helpers/swarm/stackServiceType/stackServiceType';
import { THIRD_PARTY_SERVICES } from '../../../helpers/fetchAllServicesInCompose/fetchAllServicesInCompose.model';
import { getLogger } from '../../../utils/logger';
import waitForDockerDaemon from '../../../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';
import isTransientDockerConnError from '../../../helpers/dockerode/isTransientDockerConnError/isTransientDockerConnError';
import fetchChangelogInfo from '../../../helpers/fetchChangelogInfo/fetchChangelogInfo';
import getCurrentVersion from '../../../helpers/getCurrentVersion/getCurrentVersion';
import buildOutboundErrorReply from '../../../diagnosis/buildOutboundErrorReply';
import normalizeUpstreamErrorBody from '../../../helpers/normalizeUpstreamErrorBody/normalizeUpstreamErrorBody';
import buildLocalErrorReply from '../../../diagnosis/buildLocalErrorReply';
import { getDisasterRecoveryUpdateBlock } from '../../../helpers/disasterRecovery/disasterRecovery';

const logger = getLogger();

const normalizeVersion = (version: string | null): string | null =>
  version ? version.split('-')[0] : null;

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';
const windowsYear = process.env.WINDOWS_YEAR;

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
      } catch (error) {
        if (isTransientDockerConnError(error)) {
          req.log.warn(
            '[get-service-version] Docker daemon not ready — falling back to compose.yml',
          );
          return false;
        }
        throw error;
      }
    })();

    const swarm = (await getOrchestrator(req.server.docker)).mode === 'swarm';

    // Compose reads the label the Conductor wrote at startup. Swarm never
    // writes it, so a stack service without one is typed from its image.
    const serviceTypeOf = (
      serviceId: string,
      svc: Readonly<ComposeService> | undefined,
    ): string | number | boolean | null | undefined => {
      if (swarm) {
        return stackServiceType(serviceId, svc);
      }

      const labels = svc?.labels;

      return Array.isArray(labels)
        ? labels
            .find(l => l.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
            ?.split('=')[1]
        : labels?.[`${LabelPrefix.CONDUCTOR}.type`];
    };

    // A swarm Conductor is never offered a version that is not newer than
    // itself (the catalog's GA has no Swarm support)
    const isConductorDowngrade = (
      image: string | undefined,
      running: string | null | undefined,
      target: string | null | undefined,
    ): boolean =>
      swarm &&
      parseImage(image).shortImageName === 'conductor' &&
      conductorUpdateRefusal(running, target) !== null;

    const needsUpdate = async (serviceId: string): Promise<boolean> => {
      const svc = composeJson.services?.[serviceId];
      if (!svc) {
        return false;
      }

      const {
        shortImageName,
        tag: composeTag,
        interpolatedTag,
      } = parseImage(svc.image);

      const isThirdParty = serviceTypeOf(serviceId, svc) === 'third-party';

      const imageNameToFetch =
        isWindows && isThirdParty && windowsYear
          ? `${shortImageName}-win-${windowsYear}`
          : shortImageName;

      const [svcInfo, currentVersion] = await Promise.all([
        fetchAgentInfo(imageNameToFetch),
        getCurrentVersion(
          req.server.docker,
          composeJson,
          serviceId,
          dockerReady,
        ),
      ]);

      const expectedVersion = getVersionByChannel(svcInfo, channel);
      if (!expectedVersion) {
        return false;
      }

      const versionToCheck =
        normalizeVersion(currentVersion) || normalizeVersion(composeTag);

      // `image:${TAG}` has no version to compare while nothing runs
      if (interpolatedTag && !versionToCheck) {
        return false;
      }

      return (
        expectedVersion !== versionToCheck &&
        !isConductorDowngrade(svc.image, versionToCheck, expectedVersion)
      );
    };

    const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
    const conductorName = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
    const chronosName = process.env.CHRONOS_NAME || 'gluesync-chronos';

    const { shortImageName, tag: fallbackVersion } = parseImage(service.image);

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

          return serviceTypeOf(svcId, svc) === 'module';
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
          } catch (error) {
            logger.warn(
              { service: svcId, error },
              '[get-service-version] needsUpdate failed',
            );

            return {
              id: svcId,
              needsUpdate: false,
            };
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

    const isThirdParty = serviceTypeOf(id, service) === 'third-party';

    const imageNameToFetch =
      isWindows && isThirdParty && windowsYear
        ? `${shortImageName}-win-${windowsYear}`
        : shortImageName;

    const [currentVersion, serviceInfo] = await Promise.all([
      getCurrentVersion(req.server.docker, composeJson, id, dockerReady),
      fetchAgentInfo(imageNameToFetch),
    ]);

    const actualCurrentVersion =
      normalizeVersion(currentVersion) || normalizeVersion(fallbackVersion);

    // Offered versions that would be a downgrade are left out, so no client
    // derives an update (or a changelog) from them
    const offered = (version: string | undefined): string | undefined =>
      isConductorDowngrade(service.image, actualCurrentVersion, version)
        ? undefined
        : version;

    const expectedVersion = offered(
      getVersionByChannel(serviceInfo, channel) ?? undefined,
    );

    const changelogData = await (async () => {
      if (!expectedVersion) {
        return undefined;
      }

      try {
        const result = await fetchChangelogInfo(
          shortImageName,
          expectedVersion,
        );

        const { id, ...data } = result;

        logger.debug({ id }, '[get-service-version] changelog fetched');

        return data;
      } catch (error) {
        logger.warn(
          {
            shortImageName,
            expectedVersion,
            error,
          },
          '[get-service-version] failed to fetch changelog',
        );

        return undefined;
      }
    })();

    // Core Hub and Chronos of a disaster-recovery pair are not updated from
    // here: the UI shows why the button is disabled
    const updateBlock = await getDisasterRecoveryUpdateBlock(composeJson, id);

    return reply.send({
      success: true,
      data: {
        currentVersion: actualCurrentVersion || fallbackVersion,
        latestVersionAlpha: offered(serviceInfo?.latestVersionAlpha),
        latestVersionBeta: offered(serviceInfo?.latestVersionBeta),
        latestVersionGA: offered(serviceInfo?.latestVersionGA),
        mandatoryUpdate: mandatoryUpdateResult.mandatoryUpdate,
        servicesToUpdate: mandatoryUpdateResult.servicesToUpdate,
        ...updateBlock,
        changelogData,
      },
    });
  } catch (error: any) {
    logger.error({ error }, '[get-service-version] unexpected error');

    // A compose file that is empty or corrupt is this install's own problem.
    const local = buildLocalErrorReply(
      error,
      'Unable to retrieve service version',
    );

    if (local) {
      return reply.code(local.statusCode).send(local.body);
    }

    // Failures reaching MOLO17's own services are diagnosed (who is at fault, what to do).
    // A 404 is the backoffice's answer for an image it does not publish (a custom
    // service, a Windows build), so it keeps its upstream status and body.
    const outbound = await buildOutboundErrorReply(error, undefined, {
      passThroughStatuses: [404],
    });

    if (outbound) {
      return reply.code(outbound.statusCode).send(outbound.body);
    }

    if (error?.response) {
      return reply.code(error.response.status).send({
        success: false,
        ...normalizeUpstreamErrorBody(
          error.response.data,
          'Unable to retrieve service version',
        ),
      });
    }

    return reply.code(502).send({
      success: false,
      error: 'Unable to retrieve service version',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
