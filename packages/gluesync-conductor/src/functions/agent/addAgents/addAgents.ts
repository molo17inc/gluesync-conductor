import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../../../helpers/composeFile/writeComposeFile/writeComposeFile';
import {
  AddAgentsHandler,
  AgentResultItem,
  AddAgentsSuccessResponse,
  createAgentError,
} from './addAgents.model';

const handler: AddAgentsHandler = async (req, reply) => {
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

          if (existingService) {
            reject(
              createAgentError(
                'Agent already existing in file',
                404,
                serviceId,
              ),
            );
          } else if (!type) {
            reject(createAgentError('Agent type missing', 400, serviceId));
          } else {
            const service = createComposeService('agent', {
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
              service,
            });
          }
        }),
    );

    const results = await Promise.allSettled(agentPromises);

    const newServices = results.reduce((acc, result) => {
      if (result.status === 'fulfilled' && result.value.success) {
        return { ...acc, [result.value.serviceId]: result.value.service };
      }
      return acc;
    }, {});

    const updatedCompose = {
      ...composeJson,
      services: { ...composeJson.services, ...newServices },
    };

    await writeComposeFile(updatedCompose);

    // Compose the typed response object
    const response: AddAgentsSuccessResponse = {
      success: true,
      results: results.map(r => {
        if (r.status === 'fulfilled') {
          return r.value;
        }

        // Extract proper error info from reject object
        const reason = r.reason || {};
        return {
          success: false,
          error: reason.error || reason.message || 'Unknown error',
          serviceId: reason.serviceId,
        };
      }),
      data: updatedCompose,
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
