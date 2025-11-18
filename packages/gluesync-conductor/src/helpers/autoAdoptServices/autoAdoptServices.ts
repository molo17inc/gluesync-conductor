import { v4 as uuidv4 } from 'uuid';
import {
  composeServiceFieldConfig,
  LabelPrefix,
} from '../../models/composeFile.model';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAllServicesInCompose from '../fetchAllServicesInCompose/fetchAllServicesInCompose';
import parseImage from '../parseImage/parseImage';
import agentsJson from '../../../agents.json';
import extractKeyValue from '../composeFile/extractKeyValue/extractKeyValue';

/**
 * Function to apply Conductor labels to services in docker-compose.yml.
 * Services with type labels will be handled by Conductor
 */
const autoAdoptServices = async (): Promise<{
  success: boolean;
  updatedIds: readonly string[];
  unmatchedIds: readonly string[];
}> => {
  try {
    const composeJson = await readComposeFile({ raw: true });

    // Extract all service IDs without the EXCLUDED_SERVICES
    const allServiceIds: readonly string[] = fetchAllServicesInCompose(
      composeJson,
      false,
    ).filter(id => {
      const service = composeJson.services?.[id];
      if (!service) return false;

      const initialLabels: readonly string[] = Array.isArray(service.labels)
        ? service.labels
        : Object.entries(service.labels || {}).map(([k, v]) => `${k}=${v}`);

      const hasConductorType = initialLabels.some(label =>
        label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`),
      );

      return !hasConductorType;
    });

    // If no services need updating, bail out early
    if (allServiceIds.length === 0) {
      return {
        success: true,
        updatedIds: [],
        unmatchedIds: [],
      };
    }

    const { updatedServices, updatedIds, unmatchedIds } = allServiceIds.reduce(
      (acc, id) => {
        const service = composeJson.services?.[id];
        if (!service) {
          throw new Error(`Service ${id} not found`);
        }

        const initialLabels: readonly string[] = Array.isArray(service.labels)
          ? service.labels
          : Object.entries(service.labels || {}).map(([k, v]) => `${k}=${v}`);

        const { imageName } = parseImage(service.image);

        const agentEntry = (agentsJson.data || []).find(
          (agent: any) => agent.dockerHubRepoName === imageName,
        );

        if (!agentEntry) {
          // No match in agents.json → track as unmatched
          return {
            updatedServices: {
              ...acc.updatedServices,
              [id]: { ...service, labels: initialLabels },
            },
            updatedIds: acc.updatedIds,
            unmatchedIds: [...acc.unmatchedIds, id],
          };
        }

        // Decide conductor type with stricter rules
        const conductorType: string | null = (() => {
          if (agentEntry.dockerHubRepoName === 'gluesync-core-hub') {
            return 'core-hub';
          }

          const isTargetValid = typeof agentEntry.isTarget === 'boolean';
          const isSourceValid = typeof agentEntry.isSource === 'boolean';

          if (isTargetValid && isSourceValid) {
            if (agentEntry.isTarget || agentEntry.isSource) {
              return 'agent';
            }
            return 'module';
          }

          // If neither property is a boolean, we consider it unmatched
          return null;
        })();

        if (!conductorType) {
          // No valid conductor type → track as unmatched
          return {
            updatedServices: {
              ...acc.updatedServices,
              [id]: { ...service, labels: initialLabels },
            },
            updatedIds: acc.updatedIds,
            unmatchedIds: [...acc.unmatchedIds, id],
          };
        }

        // Generate a short UUID only for agent type
        const agentId = conductorType === 'agent' ? uuidv4().split('-')[0] : id;

        // Add conductor type label and service_id label
        const finalLabels = [
          ...initialLabels,
          `${LabelPrefix.CONDUCTOR}.type=${conductorType}`,
          ...(conductorType === 'agent'
            ? [`${LabelPrefix.CONDUCTOR}.service_id=${agentId}`]
            : []),
        ];

        // Normalize environment
        const normalizedEnv = extractKeyValue(
          composeServiceFieldConfig.environment.separator,
          service.environment,
        );

        const finalEnvironment =
          conductorType === 'agent'
            ? { ...normalizedEnv, INITIAL_AGENT_ID: agentId }
            : normalizedEnv;

        const envArray = Object.entries(finalEnvironment).map(
          ([key, value]) => `${key}=${value}`,
        );

        return {
          updatedServices: {
            ...acc.updatedServices,
            [id]: { ...service, labels: finalLabels, environment: envArray },
          },
          updatedIds: [...acc.updatedIds, id],
          unmatchedIds: acc.unmatchedIds,
        };
      },
      {
        updatedServices: {},
        updatedIds: [] as ReadonlyArray<string>,
        unmatchedIds: [] as ReadonlyArray<string>,
      },
    );

    if (updatedIds.length === 0) {
      return {
        success: true,
        updatedIds: [],
        unmatchedIds,
      };
    }

    const updatedComposeFile = { ...composeJson, services: updatedServices };
    await writeComposeFile(updatedComposeFile);

    return {
      success: true,
      updatedIds,
      unmatchedIds,
    };
  } catch (error) {
    console.error(
      `Failed to apply Conductor labels: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      success: false,
      updatedIds: [],
      unmatchedIds: [],
    };
  }
};

export default autoAdoptServices;
