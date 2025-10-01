import agentValidation from '../../../helpers/agentValidation/agentValidation';
import cleanResults from '../../../helpers/cleanResults/cleanResults';
import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';
import { castObject } from '../../../helpers/composeFile/extractKeyValue/extractKeyValue';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import processAgents from '../../../helpers/processAgent/processAgent';
import { Agent } from '../../../helpers/processAgent/processAgent.model';
import {
  EditAgentsHandler,
  EditAgentsQuerystring,
  EditAgentsSuccessResponse,
} from './editAgents.model';

const handler: EditAgentsHandler = async (req, reply) => {
  const { raw } = castObject<EditAgentsQuerystring>(req.query) || false;
  const agents: ReadonlyArray<Agent> = req.body.agents ?? [];
  const composeJson = await readComposeFile({ raw: true });

  try {
    const { results } = await processAgents(
      composeJson,
      agents,
      (agentToValidate, servicesInCompose) =>
        agentValidation('edit', agentToValidate, servicesInCompose),
      ({ reservations, limits, ...agent }) =>
        createComposeService('agent', {
          ...agent,
          resources: { reservations, limits },
        }),
    );

    const response: EditAgentsSuccessResponse = {
      success: true,
      results: raw ? results : await cleanResults(results),
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
