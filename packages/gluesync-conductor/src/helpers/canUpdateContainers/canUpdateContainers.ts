import { LabelPrefix } from '../../models/composeFile.model';
import fetchAgentInfo from '../agentInfo/agentInfo';
import { AgentInfoResponse } from '../agentInfo/agentInfo.model';
import parseImage from '../parseImage/parseImage';
import { CanUpdateContainers } from './canUpdateContainers.model';

const canUpdateContainers: CanUpdateContainers = async (
  containerIds,
  composeJson,
) => {
  // Build promises tagged with isAgent
  const taggedPromises = containerIds.map(id => {
    const service = composeJson.services?.[id];
    if (!service) {
      return Promise.reject(new Error(`Service ${id} not found`));
    }

    const { shortImageName } = parseImage(service.image);
    const isAgent = service.labels?.includes(
      `${LabelPrefix.CONDUCTOR}.type=agent`,
    );

    return fetchAgentInfo(shortImageName).then(agentInfo => ({
      id,
      agentInfo,
      isAgent,
    }));
  });

  const coreHubId = process.env.CORE_HUB_NAME || 'gluesync-core-hub';

  const extendedTaggedPromises =
    taggedPromises.length > 0
      ? [
          ...taggedPromises,
          fetchAgentInfo(parseImage(coreHubId).shortImageName).then(
            agentInfo => ({
              id: coreHubId,
              agentInfo,
              isAgent: true,
            }),
          ),
        ]
      : taggedPromises;

  const settledResults = await Promise.allSettled(extendedTaggedPromises);

  const errors = settledResults.map(result =>
    result.status === 'rejected'
      ? result.reason?.message || String(result.reason)
      : null,
  );

  if (errors.some(e => e !== null)) {
    const errorMessages = errors.filter(Boolean).join('\n');
    return {
      success: false,
      errors,
      message: errorMessages,
    };
  }

  const fulfilledInfos = settledResults
    .filter(
      (
        r,
      ): r is PromiseFulfilledResult<{
        id: string;
        agentInfo: AgentInfoResponse;
        isAgent: boolean;
      }> => r.status === 'fulfilled',
    )
    .map(r => r.value);

  const agents = fulfilledInfos.filter(info => info.isAgent);
  const modules = fulfilledInfos.filter(info => !info.isAgent);

  const agentVersions = agents.map(
    info => info.agentInfo.AvailableAgents?.latestVersionGA,
  );

  const allEqual =
    agentVersions.length === 0 ||
    !agentVersions.some(v => v !== agentVersions[0]);

  if (!allEqual) {
    return {
      success: false,
      errors: ['Agent versions mismatch'],
      message: 'Agent versions mismatch',
    };
  }

  return {
    success: true,
    errors: [] as (string | null)[],
    message: '',
    data: {
      agentVersion: agentVersions[0] ?? null,
      modules: modules.map(info => ({
        id: info.id,
        version: info.agentInfo.AvailableAgents?.latestVersionGA ?? null,
      })),
    },
  };
};

export default canUpdateContainers;
