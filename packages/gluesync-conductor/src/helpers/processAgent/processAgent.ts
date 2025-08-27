import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import extractImageInfo from '../extractCleanImageName/extractImageInfo';
import {
  AgentResultItem,
  CreateAgentError,
  ProcessAgents,
} from './processAgent.model';

const createAgentError: CreateAgentError = (message, status, serviceId) => {
  const error = new Error(message);
  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
    status,
    serviceId,
    error: message,
  };
};

const processAgents: ProcessAgents = async (
  serviceType,
  composeJson,
  agents,
  validateExistence,
  createService,
  existErrorMsg,
  typeErrorMsg,
) => {
  const coreHub =
    composeJson.services?.[process.env.CORE_HUB_NAME || 'gluesync-core-hub'];

  const coreHubVersionTag = extractImageInfo(coreHub?.image || '').tag;

  if (!coreHubVersionTag) {
    throw new Error('Core-hub Version Tag not found or empty');
  }

  const agentPromises = agents.map(
    agent =>
      new Promise<AgentResultItem>((resolve, reject) => {
        const { imageName, type } = agent;
        const serviceId = `${imageName}-${type}-${serviceType}`;
        const existingService = composeJson.services?.[serviceId];

        if (validateExistence(existingService)) {
          reject(createAgentError(existErrorMsg, 404, serviceId));
        } else if (!type) {
          reject(createAgentError(typeErrorMsg, 400, serviceId));
        } else {
          const service = createService({
            ...agent,
            tag: coreHubVersionTag,
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

  const updatedServices = results.reduce(
    (acc, result) =>
      result.status === 'fulfilled' && result.value.success
        ? { ...acc, [result.value.serviceId]: result.value.service }
        : acc,
    {},
  );

  const updatedComposeJson = {
    ...composeJson,
    services: {
      ...composeJson.services,
      ...updatedServices,
    },
  };

  await writeComposeFile(updatedComposeJson);

  return {
    results: results.map(r =>
      r.status === 'fulfilled'
        ? r.value
        : {
            success: false,
            error:
              (r.reason && (r.reason.error || r.reason.message)) ||
              'Unknown error',
            serviceId: r.reason?.serviceId,
          },
    ),
    updatedComposeJson,
  };
};

export default processAgents;
