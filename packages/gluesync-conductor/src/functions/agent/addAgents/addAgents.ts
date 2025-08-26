import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';
import processAgents from '../../../helpers/processAgent/processAgent';
import { Agent } from '../../../helpers/processAgent/processAgent.model';
import { AddAgentsHandler, AddAgentsSuccessResponse } from './addAgents.model';

const handler: AddAgentsHandler = async (req, reply) => {
  try {
    const agents: ReadonlyArray<Agent> = req.body.agents ?? [];

    const { results, updatedComposeJson } = await processAgents(
      agents,
      existingService => !!existingService, // error if agent exists
      agent => createComposeService('agent', agent),
      'Agent already existing in file',
      'Agent type missing',
    );

    const response: AddAgentsSuccessResponse = {
      success: true,
      results,
      data: updatedComposeJson,
    };

    reply.code(200).send(response);
  } catch (error) {
    reply.code(500).send({
      success: false,
      error: `Failed to add agents: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;
