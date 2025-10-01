import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import processAgents from '../../../helpers/processAgent/processAgent';
import { Agent } from '../../../helpers/processAgent/processAgent.model';
import {
  AddAgentsHandler,
  AddAgentsQuerystring,
  AddAgentsSuccessResponse,
} from './addAgents.model';
import createAgent from '../../../helpers/processAgent/agent.factory';
import agentValidation from '../../../helpers/agentValidation/agentValidation';
import { castObject } from '../../../helpers/composeFile/extractKeyValue/extractKeyValue';
import cleanResults from '../../../helpers/cleanResults/cleanResults';

const handler: AddAgentsHandler = async (req, reply) => {
  try {
    const { raw } = castObject<AddAgentsQuerystring>(req.query) || false;
    const agents: ReadonlyArray<Agent> = req.body.agents ?? [];
    const agentsWithIds = agents.map(createAgent);

    const rawComposeJson = await readComposeFile({ raw: true });

    const { results } = await processAgents(
      'agent',
      rawComposeJson,
      agentsWithIds,
      (agentToValidate, serviceId, servicesInCompose) =>
        agentValidation('add', agentToValidate, serviceId, servicesInCompose),
      ({ reservations, limits, ...agent }) =>
        createComposeService('agent', {
          ...agent,
          id: agent.id,
          resources: { reservations, limits },
        }),
    );

    const response: AddAgentsSuccessResponse = {
      success: true,
      results: raw ? results : await cleanResults(results),
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
