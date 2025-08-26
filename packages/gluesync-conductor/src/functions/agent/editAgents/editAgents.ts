import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../../../helpers/composeFile/writeComposeFile/writeComposeFile';
import {
  AgentResultItem,
  createAgentError,
  EditAgentsHandler,
  EditAgentsSuccessResponse,
} from './editAgents.model';

const handler: EditAgentsHandler = async (req, reply) => {
  try {
    const composeJson = await readComposeFile({ raw: true });

    const agentPromises: Promise<AgentResultItem>[] = (
      req.body.agents || []
    ).map(
      agent =>
        new Promise<AgentResultItem>((resolve, reject) => {
          const {
            imageName,
            type,
            nickname,
            tag,
            environment,
            labels,
            ports = [],
            volumes = [],
            limits,
            reservations,
          } = agent;

          const serviceId = `${imageName}-${type}-agent`;
          const existingService = composeJson.services?.[serviceId];

          console.log(
            '>>>>>>> CONSOLE LOG FOR existingService',
            existingService,
          );

          if (!existingService) {
            reject(
              createAgentError('Agent not existing in file', 404, serviceId),
            );
          } else if (!type) {
            reject(createAgentError('Agent type missing', 400, serviceId));
          } else {
            // Create the updated service object
            const updatedService = createComposeService('agent', {
              imageName,
              type,
              nickname,
              tag,
              environment,
              ports,
              volumes,
              labels,
              resources: { limits, reservations },
            });

            resolve({
              success: true,
              serviceId,
              service: updatedService,
            });
          }
        }),
    );

    const results = await Promise.allSettled(agentPromises);

    // Build updated services object, only from successful modifications
    const updatedServices = results.reduce((acc, result) => {
      if (result.status === 'fulfilled' && result.value.success) {
        return { ...acc, [result.value.serviceId]: result.value.service };
      }
      return acc;
    }, {});

    // Merge updates immutably into composeJson
    const newComposeJson = {
      ...composeJson,
      services: {
        ...composeJson.services,
        ...updatedServices,
      },
    };

    await writeComposeFile(newComposeJson);

    // Prepare results for client response
    const response: EditAgentsSuccessResponse = {
      success: true,
      results: results.map(r => {
        if (r.status === 'fulfilled') {
          return r.value;
        }
        const reason = r.reason || {};
        return {
          success: false,
          error: reason.error || reason.message || 'Unknown error',
          serviceId: reason.serviceId,
        };
      }),
      data: newComposeJson,
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
