import fetchAgentInfo from '../agentInfo/agentInfo';
import { AgentInfoResponse } from '../agentInfo/agentInfo.model';
import extractImageInfo from '../extractImageInfo/extractImageInfo';
import { CanUpdateContainers } from './canUpdateContainers.model';

const canUpdateContainers: CanUpdateContainers = async (
  containerIds,
  composeJson,
) => {
  const agentInfoPromises = containerIds.map(async id => {
    const service = composeJson.services?.[id];
    if (!service) {
      return Promise.reject(new Error(`Agent ${id} not found`));
    }
    const cleanedName = extractImageInfo(service.image).name;
    return fetchAgentInfo(cleanedName);
  });

  const settledResults = await Promise.allSettled(agentInfoPromises);

  // Collect error messages or null for each container
  const errors = settledResults.map(result =>
    result.status === 'rejected'
      ? result.reason?.message || String(result.reason)
      : null,
  );

  // If any errors exist, aggregate them and return the error object
  const hasErrors = errors.some(e => e !== null);
  if (hasErrors) {
    const errorMessages = errors.filter(Boolean).join('\n');
    return {
      success: false,
      errors,
      message: errorMessages,
    };
  }

  // Extract fulfilled results with agent info
  const fulfilledAgentInfos = settledResults
    .filter(
      (r): r is PromiseFulfilledResult<AgentInfoResponse> =>
        r.status === 'fulfilled',
    )
    .map(r => r.value);

  // Extract latestVersionGA, filtering out falsy values
  const latestVersions = fulfilledAgentInfos.map(
    agentInfo => agentInfo.AvailableAgents?.latestVersionGA,
  );

  const allEqual = !latestVersions.some(v => v !== latestVersions[0]);

  if (!allEqual) {
    return {
      success: false,
      errors: ['Agent versions mismatch'],
      message: 'Agent versions mismatch',
    };
  }

  return {
    success: true,
    errors: [],
    message: '',
    data: latestVersions[0],
  };
};

export default canUpdateContainers;
