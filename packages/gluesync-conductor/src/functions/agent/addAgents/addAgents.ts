import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import processAgents from '../../../helpers/processAgent/processAgent';
import { Agent } from '../../../helpers/processAgent/processAgent.model';
import { AddAgentsHandler, AddAgentsSuccessResponse } from './addAgents.model';
import createAgent from '../../../helpers/processAgent/agent.factory';
import agentValidation from '../../../helpers/agentValidation/agentValidation';

const handler: AddAgentsHandler = async (req, reply) => {
  try {
    const agents: ReadonlyArray<Agent> = req.body.agents ?? [];
    const agentsWithIds = agents.map(createAgent);

    const composeJson = await readComposeFile({ raw: true });

    const { results } = await processAgents(
      composeJson,
      agentsWithIds,
      (agentToValidate, servicesInCompose) =>
        agentValidation('add', agentToValidate, servicesInCompose),
      ({ reservations, limits, ...agent }) =>
        createComposeService('agent', {
          ...agent,
          resources: { reservations, limits },
        }),
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
