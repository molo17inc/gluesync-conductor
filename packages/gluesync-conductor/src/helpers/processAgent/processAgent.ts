import {
  RawComposeFile,
  RawComposeService,
} from '../../models/composeFile.model';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import { Agent, AgentResultItem } from './processAgent.model';

const createAgentError = (
  message: string,
  status: number,
  serviceId: string,
): Error & { status: number; serviceId: string; error: string } => {
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

const processAgents = async (
  agents: ReadonlyArray<Agent>,
  validateExistence: (existingService: any) => boolean,
  createService: (agent: Agent) => RawComposeService,
  existErrorMsg: string,
  typeErrorMsg: string,
): Promise<{
  results: AgentResultItem[];
  updatedComposeJson: RawComposeFile;
}> => {
  const composeJson = await readComposeFile({ raw: true });

  const agentPromises = agents.map(
    agent =>
      new Promise<AgentResultItem>((resolve, reject) => {
        const { imageName, type } = agent;
        const serviceId = `${imageName}-${type}-agent`;
        const existingService = composeJson.services?.[serviceId];

        if (validateExistence(existingService)) {
          reject(createAgentError(existErrorMsg, 404, serviceId));
        } else if (!type) {
          reject(createAgentError(typeErrorMsg, 400, serviceId));
        } else {
          const service = createService(agent);
          resolve({
            success: true,
            serviceId,
            service,
          });
        }
      }),
  );

  const results = await Promise.allSettled(agentPromises);

  const updatedServices = results.reduce((acc, result) => {
    if (result.status === 'fulfilled' && result.value.success) {
      return { ...acc, [result.value.serviceId]: result.value.service };
    }
    return acc;
  }, {});

  const updatedComposeJson = {
    ...composeJson,
    services: {
      ...composeJson.services,
      ...updatedServices,
    },
  };

  await writeComposeFile(updatedComposeJson);

  return {
    results: results.map(r => {
      if (r.status === 'fulfilled') return r.value;
      const reason = r.reason || {};
      return {
        success: false,
        error: reason.error || reason.message || 'Unknown error',
        serviceId: reason.serviceId,
      };
    }),
    updatedComposeJson,
  };
};

export default processAgents;
