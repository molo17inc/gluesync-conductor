import { LabelPrefix } from '../../models/composeFile.model';
import { ConductorServiceTypes } from '../../models/conductor.model';
import fetchAgentInfo from '../agentInfo/agentInfo';
import { AgentInfoResponse } from '../agentInfo/agentInfo.model';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';
import { CanUpdateContainers } from './canUpdateContainers.model';

const getWindowsYearFromTag = (tag: string): '2019' | '2022' | null => {
  const lower = (tag || '').toLowerCase();
  if (lower.includes('ltsc2022')) {
    return '2022';
  }
  if (lower.includes('ltsc2019')) {
    return '2019';
  }
  return null;
};

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const canUpdateContainers: CanUpdateContainers = async (
  containerIds,
  composeJson,
  releaseChannel,
) => {
  const isWindows = (process.env.IS_WINDOWS || '').toLowerCase() === 'true';

  // Labels can be a list ("k=v") or a map; both are normalised to "k=v".
  const serviceTypeOf = (id: string): ConductorServiceTypes | undefined => {
    const labels = composeJson.services?.[id]?.labels;
    const labelStrings: ReadonlyArray<string> = Array.isArray(labels)
      ? labels
      : Object.entries(labels || {}).map(([k, v]) => `${k}=${v}`);
    return labelStrings
      .find(label => label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
      ?.split('=')[1] as ConductorServiceTypes | undefined;
  };

  // Build promises tagged with service type
  const taggedPromises = containerIds.map(id => {
    const service = composeJson.services?.[id];
    if (!service) {
      return Promise.reject(new Error(`Service ${id} not found`));
    }

    const parsed = parseImage(service.image);
    const serviceType = serviceTypeOf(id);

    // Append Windows year ONLY for third-party services
    const isThirdParty = serviceType === 'third-party';
    const windowsYear =
      isWindows && isThirdParty ? getWindowsYearFromTag(parsed.tag) : null;

    const imageNameToFetch = windowsYear
      ? `${parsed.shortImageName}-win-${windowsYear}`
      : parsed.shortImageName;

    return fetchAgentInfo(imageNameToFetch).then(agentInfo => ({
      id,
      agentInfo,
      type: serviceType,
    }));
  });

  const settledResults = await Promise.allSettled(taggedPromises);

  // Explicitly fetch core-hub info
  const coreHubVersionInfo = await fetchAgentInfo(
    parseImage('gluesync-core-hub').shortImageName,
  ).catch((error: unknown) => {
    throw new Error(
      `Could not get the latest core-hub version from the backoffice: ${reasonOf(error)}`,
    );
  });

  // Agents and core-hub move together, so any of them failing stops the
  // update. A module (chronos, grafana, ...) that cannot be looked up is only
  // skipped: it used to block every other service with an anonymous error.
  const failures = settledResults.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return [];
    }
    const id = containerIds[index];
    const known = !!composeJson.services?.[id];
    return [
      {
        id,
        blocking:
          !known || ['agent', 'core-hub'].includes(serviceTypeOf(id) ?? ''),
        reason: known
          ? `Could not get the latest version of ${id} from the backoffice: ${reasonOf(result.reason)}`
          : reasonOf(result.reason),
      },
    ];
  });

  const blocking = failures.filter(f => f.blocking).map(f => f.reason);
  if (blocking.length > 0) {
    return {
      success: false,
      errors: blocking,
      message: blocking.join('\n'),
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

  const modules = fulfilledInfos.filter(
    info => info.type === 'module' || info.type === 'third-party',
  );

  // Collect agent versions
  const agentVersions = agentsAndCoreHub.map(info => ({
    id: info.id,
    version: getVersionByChannel(info.agentInfo, releaseChannel),
  }));

  // Include core-hub version in the agent consistency
  const coreHubVersion = getVersionByChannel(
    coreHubVersionInfo,
    releaseChannel,
  );

  const allAgentVersions = coreHubVersion
    ? [...agentVersions, { id: 'core-hub (latest)', version: coreHubVersion }]
    : agentVersions;

  // Check all agent versions (including core-hub) are equal
  const allEqual =
    allAgentVersions.length === 0 ||
    !allAgentVersions.some(v => v.version !== allAgentVersions[0].version);

  if (!allEqual) {
    const message = `Agent versions mismatch (including core-hub): ${allAgentVersions
      .map(v => `${v.id} ${v.version ?? 'none'}`)
      .join(', ')}`;
    return {
      success: false,
      errors: [message],
      message,
    };
  }

  return {
    success: true,
    errors: [] as (string | null)[],
    message: '',
    data: {
      agentVersion: allAgentVersions[0]?.version ?? null,
      modules: modules.map(info => ({
        id: info.id,
        version: getVersionByChannel(info.agentInfo, releaseChannel) ?? null,
      })),
      skipped: failures.map(f => ({ id: f.id, reason: f.reason })),
    },
  };
};

export default canUpdateContainers;
