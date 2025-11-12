import { LabelPrefix } from '../../models/composeFile.model';
import { ConductorServiceTypes } from '../../models/conductor.model';
import fetchAgentInfo from '../agentInfo/agentInfo';
import { AgentInfoResponse } from '../agentInfo/agentInfo.model';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';
import { CanUpdateContainers } from './canUpdateContainers.model';

const canUpdateContainers: CanUpdateContainers = async (
  containerIds,
  composeJson,
  releaseChannel,
) => {
  // Build promises tagged with service type
  const taggedPromises = containerIds.map(id => {
    const service = composeJson.services?.[id];
    if (!service) {
      return Promise.reject(new Error(`Service ${id} not found`));
    }

    const { shortImageName } = parseImage(service.image);

    const serviceType = service?.labels
      ?.find(label => label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
      ?.split('=')[1] as ConductorServiceTypes | undefined;

    return fetchAgentInfo(shortImageName).then(agentInfo => ({
      id,
      agentInfo,
      type: serviceType,
    }));
  });

  // Explicitly fetch core-hub info
  const coreHubVersionInfo = await fetchAgentInfo(
    parseImage(process.env.CORE_HUB_NAME || 'gluesync-core-hub').shortImageName,
  );

  const settledResults = await Promise.allSettled(taggedPromises);

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
        type: ConductorServiceTypes | undefined;
      }> => r.status === 'fulfilled',
    )
    .map(r => r.value);

  // Partition by type
  const agentsAndCoreHub = fulfilledInfos.filter(
    info => info.type === 'agent' || info.type === 'core-hub',
  );
  const modules = fulfilledInfos.filter(info => info.type === 'module');

  // Collect agent versions
  const agentVersions = agentsAndCoreHub.map(info =>
    getVersionByChannel(info.agentInfo, releaseChannel),
  );

  // Include core-hub version in the agent consistency
  const coreHubVersion = getVersionByChannel(
    coreHubVersionInfo,
    releaseChannel,
  );
  const allAgentVersions = coreHubVersion
    ? [...agentVersions, coreHubVersion]
    : agentVersions;

  // Check all agent versions (including core-hub) are equal
  const allEqual =
    allAgentVersions.length === 0 ||
    !allAgentVersions.some(v => v !== allAgentVersions[0]);

  if (!allEqual) {
    return {
      success: false,
      errors: ['Agent versions mismatch (including core-hub)'],
      message: 'Agent versions mismatch (including core-hub)',
    };
  }

  return {
    success: true,
    errors: [] as (string | null)[],
    message: '',
    data: {
      agentVersion: allAgentVersions[0] ?? null,
      modules: [
        ...modules.map(info => ({
          id: info.id,
          version: getVersionByChannel(info.agentInfo, releaseChannel) ?? null,
        })),
      ],
    },
  };
};

export default canUpdateContainers;
