import {
  GetServiceVersionHandler,
  GetServiceVersionParams,
} from './getServiceVersion.model';
import { castObject } from '../../../helpers/composeFile/extractKeyValue/extractKeyValue';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import { LabelPrefix } from '../../../models/composeFile.model';
import fetchAgentInfo from '../../../helpers/agentInfo/agentInfo';
import parseImage from '../../../helpers/parseImage/parseImage';

const handler: GetServiceVersionHandler = async (req, reply) => {
  try {
    const { id } = castObject<GetServiceVersionParams>(req.params);
    const composeJson = await readComposeFile();

    const service = composeJson.services?.[id];

    if (!service) {
      return reply.code(404).send({
        success: false,
        error: `Service ${id} not found in docker file`,
      });
    }

    const { shortImageName, tag } = parseImage(service.image);

    // Make a request to the backoffice API to get the latest version
    const agentInfo = await fetchAgentInfo(shortImageName);

    // Return only the version informations
    return reply.send({
      success: true,
      data: {
        currentVersion: String(tag),
        latestVersionAlpha: agentInfo.AvailableAgents?.latestVersionAlpha,
        latestVersionBeta: agentInfo.AvailableAgents?.latestVersionBeta,
        latestVersionGA: agentInfo.AvailableAgents?.latestVersionGA,
      },
    });
  } catch (error: unknown) {
    req.log.error(
      `Error getting agent version: ${error instanceof Error ? error.message : String(error)}`,
    );

    if (error instanceof Error && (error as any).statusCode === 404) {
      return reply.code(404).send({
        success: false,
        error: 'Service not found',
      });
    }

    return reply.code(500).send({
      success: false,
      error: `Failed to get agent version: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;
