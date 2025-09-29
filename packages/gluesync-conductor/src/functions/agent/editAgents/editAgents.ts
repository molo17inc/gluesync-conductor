import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import processAgents from '../../../helpers/processAgent/processAgent';
import { Agent } from '../../../helpers/processAgent/processAgent.model';
import {
  EditAgentsHandler,
  EditAgentsSuccessResponse,
} from './editAgents.model';

const handler: EditAgentsHandler = async (req, reply) => {
  const agents: ReadonlyArray<Agent> = req.body.agents ?? [];

  const composeJson = await readComposeFile({ raw: true });

  try {
    const { results } = await processAgents(
      composeJson,
      agents,
      existingService => !existingService, // error if agent not exists
      ({ reservations, limits, ...agent }) =>
        createComposeService('agent', {
          ...agent,
          resources: { reservations, limits },
        }),
      'Agent not existing in file',
      'Agent type missing',
    );

    const response: EditAgentsSuccessResponse = {
      success: true,
      results,
    };

    reply.code(200).send(response);
  } catch (error) {
    reply.code(500).send({
      success: false,
      error: `Failed to edit agents: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;
