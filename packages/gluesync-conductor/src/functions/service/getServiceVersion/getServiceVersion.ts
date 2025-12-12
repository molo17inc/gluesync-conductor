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

    // Helper to check if a service needs update based on release channel
    const needsUpdate = async (serviceId: string): Promise<boolean> => {
      const svc = composeJson.services?.[serviceId];
      if (!svc) return false;

      const { shortImageName, tag } = parseImage(svc.image);
      const svcInfo = await fetchAgentInfo(shortImageName);
      const expectedVersion = getVersionByChannel(svcInfo, channel);

      // If we can't determine the expected version, assume no update is needed
      if (!expectedVersion) {
        return false;
      }

      return expectedVersion !== tag;
    };

    const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
    const conductorName = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
    const chronosName = process.env.CHRONOS_NAME || 'gluesync-chronos';

    // Compute mandatoryUpdate without nested ternary
    const mandatoryUpdate = await (async () => {
      if (id === coreHubName) {
        // If core-hub is up-to-date, check conductor and chronos
        const conductorNeedsUpdate = await needsUpdate(conductorName);
        const chronosNeedsUpdate = await needsUpdate(chronosName);
        return conductorNeedsUpdate || chronosNeedsUpdate;
      }
      return false;
    })();

    // Always fetch info for the requested service to return version details
    const { shortImageName, tag } = parseImage(service.image);
    const serviceInfo = await fetchAgentInfo(shortImageName);

    // Strip suffix after first dash
    const currentVersion = tag.split('-')[0];

    return reply.send({
      success: true,
      data: {
        currentVersion,
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
