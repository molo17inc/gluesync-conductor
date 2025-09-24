import { v4 as uuidv4 } from 'uuid';
import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import processAgents from '../../../helpers/processAgent/processAgent';
import { Agent } from '../../../helpers/processAgent/processAgent.model';
import { AddAgentsHandler, AddAgentsSuccessResponse } from './addAgents.model';

const handler: AddAgentsHandler = async (req, reply) => {
  try {
    const agents: ReadonlyArray<Agent> = req.body.agents ?? [];

    const composeJson = await readComposeFile({ raw: true });

    const { results } = await processAgents(
      'agent',
      composeJson,
      agents,
      existingService => !!existingService, // error if agent exists
      ({ reservations, limits, environment, ...agent }) =>
        createComposeService('agent', {
          ...agent,
          resources: { reservations, limits },
          environment: {
            ...environment,
            CONDUCTOR_AGENT_ID: uuidv4().split('-')[0],
          },
        }),
      'Agent already existing in file',
      'Agent type missing',
    );

    const response: AddAgentsSuccessResponse = {
      success: true,
      results,
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
