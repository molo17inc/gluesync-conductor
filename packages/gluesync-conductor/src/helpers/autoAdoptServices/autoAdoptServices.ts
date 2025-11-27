import { v4 as uuidv4 } from 'uuid';
import {
  composeServiceFieldConfig,
  LabelPrefix,
  RawComposeService,
} from '../../models/composeFile.model';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAllServicesInCompose from '../fetchAllServicesInCompose/fetchAllServicesInCompose';
import parseImage from '../parseImage/parseImage';
import agentsJson from '../../../agents.json';
import extractKeyValue from '../composeFile/extractKeyValue/extractKeyValue';
import removeDependsOnFromServices from '../removeDependsOnFromServices/removeDependsOnFromServices';
import addGluesyncHostToAgents from '../addGluesyncHostToAgents/addGluesyncHostToAgents';
import addNetworkToServices from '../addNetworkToServices/addNetworkToServices';

/**
 * Apply platform-specific adjustments (GLUESYNC_HOST + network) to services.
 * On non-Windows, this is a no-op and returns the original services map.
 */
const applyWindowsdjustments = (
  services: Record<string, RawComposeService>,
  serviceIds: readonly string[],
  isWindows: boolean,
  gluesyncHostDefault: string,
  windowsNetworkName: string,
): Record<string, RawComposeService> =>
  isWindows
    ? (() => {
        const { services: withHostServices } = addGluesyncHostToAgents(
          services,
          serviceIds,
          gluesyncHostDefault,
        );

        const { services: withNetServices } = addNetworkToServices(
          withHostServices,
          serviceIds,
          windowsNetworkName,
        );

        return withNetServices;
      })()
    : services;

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

    const gluesyncHostDefault =
      process.env.GLUESYNC_HOST ?? 'gluesync-core-hub';

    const windowsNetworkName = 'gluesync-windows-net';

    const isWindows =
      typeof process.env.IS_WINDOWS === 'string' &&
      process.env.IS_WINDOWS.toLowerCase() === 'true';

    // Extract all service IDs without the EXCLUDED_SERVICES
    const allServiceIds: readonly string[] = fetchAllServicesInCompose(
      composeJson,
      false,
    );

    // Services that ALREADY have a conductor type label
    const alreadyLabeledIds = allServiceIds.filter(id => {
      const service = composeJson.services?.[id];
      if (!service) return false;

      const initialLabels: readonly string[] = Array.isArray(service.labels)
        ? service.labels
        : Object.entries(service.labels || {}).map(([k, v]) => `${k}=${v}`);

      const hasConductorType = initialLabels.some(label =>
        label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`),
      );

      return hasConductorType;
    });

    // First pass: remove depends_on from already-labeled services
    const { cleanedServices, removedDependsOnIds } =
      removeDependsOnFromServices(composeJson, alreadyLabeledIds);

    // Platform-specific behavior like GLUESYNC_HOST in environment and network
    const platformAdjustedLabeledServices: Record<string, RawComposeService> =
      applyWindowsdjustments(
        cleanedServices,
        alreadyLabeledIds,
        isWindows,
        gluesyncHostDefault,
        windowsNetworkName,
      );

    // If we removed depends_on from some existing labeled services and
    // there is NOTHING else to adopt, only write those changes and bail out.
    const unlabeledIds = allServiceIds.filter(
      id => !alreadyLabeledIds.includes(id),
    );

    if (unlabeledIds.length === 0) {
      if (removedDependsOnIds.length === 0) {
        return {
          success: true,
          updatedIds: [],
          unmatchedIds: [],
        };
      }

      const updatedComposeFile = {
        ...composeJson,
        services: {
          ...composeJson.services,
          ...platformAdjustedLabeledServices,
        },
      };

      await writeComposeFile(updatedComposeFile);

      return {
        success: true,
        updatedIds: [...removedDependsOnIds],
        unmatchedIds: [],
      };
    }

    // From this point on, work on a base services object where
    // already-labeled services are already cleaned from depends_on.
    const baseServices: Record<string, RawComposeService> = {
      ...composeJson.services,
      ...platformAdjustedLabeledServices,
    };

    // Second pass: adopt UNLABELED services (and ensure depends_on removed via utility)
    const { updatedServices, updatedIds, unmatchedIds } = unlabeledIds.reduce(
      (acc, id) => {
        const service = baseServices?.[id];
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

        // Use the utility to drop depends_on for this service
        const { cleanedServices: cleanedSingle } = removeDependsOnFromServices(
          { ...composeJson, services: baseServices },
          [id],
        );

        const cleanedServiceBase = cleanedSingle[id] ?? service;

        // Platform behavior for newly adopted services
        const platformAdjustedService: RawComposeService = (() => {
          if (!isWindows) {
            return cleanedServiceBase;
          }

          const singleServiceMap = { [id]: cleanedServiceBase };

          const adjustedServices =
            conductorType === 'agent'
              ? applyWindowsdjustments(
                  singleServiceMap,
                  [id],
                  true,
                  gluesyncHostDefault,
                  windowsNetworkName,
                )
              : addNetworkToServices(singleServiceMap, [id], windowsNetworkName)
                  .services;

          return adjustedServices[id] ?? cleanedServiceBase;
        })();

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
          platformAdjustedService.environment,
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
            [id]: {
              ...platformAdjustedService,
              labels: finalLabels,
              environment: envArray,
            },
          },
          updatedIds: [...acc.updatedIds, id],
          unmatchedIds: acc.unmatchedIds,
        };
      },
      {
        updatedServices: {} as Record<string, RawComposeService>,
        updatedIds: [] as ReadonlyArray<string>,
        unmatchedIds: [] as ReadonlyArray<string>,
      },
    );

    // If no newly adopted services and no depends_on was removed, bail out
    if (updatedIds.length === 0 && removedDependsOnIds.length === 0) {
      return {
        success: true,
        updatedIds: [],
        unmatchedIds,
      };
    }

    const updatedComposeFile = {
      ...composeJson,
      services: {
        ...baseServices,
        ...updatedServices,
      },
    };

    await writeComposeFile(updatedComposeFile);

    return {
      success: true,
      updatedIds: [...removedDependsOnIds, ...updatedIds],
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
