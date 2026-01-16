import {
  composeServiceFieldConfig,
  LabelPrefix,
  RawComposeService,
} from '../../models/composeFile.model';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAllServicesInCompose from '../fetchAllServicesInCompose/fetchAllServicesInCompose';
import { THIRD_PARTY_SERVICES } from '../fetchAllServicesInCompose/fetchAllServicesInCompose.model';
import parseImage from '../parseImage/parseImage';
import agentsJson from '../../../agents.json';
import extractKeyValue from '../composeFile/extractKeyValue/extractKeyValue';
import removeDependsOnFromServices from '../removeDependsOnFromServices/removeDependsOnFromServices';
import addGluesyncHostToAgents from '../addGluesyncHostToAgents/addGluesyncHostToAgents';
import addNetworkToServices from '../addNetworkToServices/addNetworkToServices';
import addPlatformVolumes from '../addPlatformVolumes/addPlatformVolumes';
import toLabelStrings from '../../utils/toLabelStrings';

/**
 * Apply platform-specific adjustments (GLUESYNC_HOST + network + volumes).
 * - Network is always applied (Linux + Windows).
 * - On non-Windows, volumes are still normalized (existing behavior).
 * Returns only the updated services and their ids.
 *
 * Note: Third-party services must be excluded by the caller.
 * Compose allows services to connect to named networks via the `networks` key. [web:45]
 */
const applyPlatformAdjustments = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
  isWindows: boolean,
  gluesyncHostDefault: string,
  networkName: string,
): {
  services: Record<string, RawComposeService>;
  updatedIds: ReadonlyArray<string>;
} => {
  // Step 1
  const step1 = isWindows
    ? addGluesyncHostToAgents(services, serviceIds, gluesyncHostDefault)
    : addPlatformVolumes(services, serviceIds, false);

  const afterStep1Services: Readonly<Record<string, RawComposeService>> = {
    ...services,
    ...step1.services,
  };

  // Step 2 (always apply network, Linux included)
  const step2 = addNetworkToServices(
    afterStep1Services,
    serviceIds,
    networkName,
  );

  const afterStep2Services: Readonly<Record<string, RawComposeService>> = {
    ...afterStep1Services,
    ...step2.services,
  };

  // Step 3
  const step3 = isWindows
    ? addPlatformVolumes(afterStep2Services, serviceIds, true)
    : { services: {}, updatedIds: [] as ReadonlyArray<string> };

  const finalServices: Readonly<Record<string, RawComposeService>> = {
    ...afterStep2Services,
    ...step3.services,
  };

  const allUpdatedIds: ReadonlyArray<string> = [
    ...step1.updatedIds,
    ...step2.updatedIds,
    ...step3.updatedIds,
  ];

  const changedServices = Object.fromEntries(
    allUpdatedIds.map(id => [id, finalServices[id]]),
  ) as Record<string, RawComposeService>;

  return {
    services: changedServices,
    updatedIds: allUpdatedIds,
  };
};

type ConductorType = 'core-hub' | 'agent' | 'module' | 'third-party';

const buildFinalLabels = (
  initialLabels: ReadonlyArray<string>,
  conductorType: ConductorType,
  serviceId: string,
): ReadonlyArray<string> => {
  // Label keys should be unique; newer values overwrite older ones, so keep this deterministic. [web:32]
  const base = initialLabels
    .filter(l => !l.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
    .filter(l => !l.startsWith(`${LabelPrefix.CONDUCTOR}.service_id=`));

  return [
    ...base,
    `${LabelPrefix.CONDUCTOR}.type=${conductorType}`,
    ...(conductorType === 'agent'
      ? [`${LabelPrefix.CONDUCTOR}.service_id=${serviceId}`]
      : []),
  ];
};

/**
 * Function to apply Conductor labels to services in docker-compose.yml.
 * Services with type labels will be handled by Conductor.
 *
 * Third-party services are always adopted by id, but must not be mutated
 * (no env/networks/volumes/depends_on changes).
 */
const autoAdoptServices = async (): Promise<{
  success: boolean;
  updatedIds: readonly string[];
  unmatchedIds: readonly string[];
}> => {
  try {
    const composeJson = await readComposeFile({ raw: true });

    if (!composeJson.services) {
      return {
        success: true,
        updatedIds: [],
        unmatchedIds: [],
      };
    }

    const gluesyncHostDefault =
      process.env.GLUESYNC_HOST ?? 'gluesync-core-hub';

    // Naming note: now used on Linux too, but keeping the existing name for compatibility.
    const networkName = 'gluesync-windows-net';

    const conductorServiceName =
      process.env.CONDUCTOR_NAME || 'gluesync-conductor';

    const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

    // Always include third-party in the scan.
    const allServiceIds: readonly string[] = fetchAllServicesInCompose(
      composeJson,
      false,
      true,
    );

    // Services that ALREADY have a conductor type label
    const alreadyLabeledIds = allServiceIds.filter(id => {
      const service = composeJson.services?.[id];
      if (!service) return false;

      const labelStrings = toLabelStrings(service.labels);

      return labelStrings.some(label =>
        label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`),
      );
    });

    // Exclude conductor + third-party from platform adjustments.
    const adjustedIds = alreadyLabeledIds.filter(
      id => id !== conductorServiceName && !THIRD_PARTY_SERVICES.has(id),
    );

    // First pass: remove depends_on from already-labeled services
    const { cleanedServices, removedDependsOnIds } =
      removeDependsOnFromServices(composeJson, alreadyLabeledIds);

    // Apply platform adjustments to already-labeled services (except third-party)
    const {
      services: platformAdjustedLabeledServices,
      updatedIds: platformAdjustedIds,
    } = applyPlatformAdjustments(
      composeJson.services,
      adjustedIds,
      isWindows,
      gluesyncHostDefault,
      networkName,
    );

    const unlabeledIds = allServiceIds.filter(
      id => !alreadyLabeledIds.includes(id),
    );

    // Nothing new to label: only write file if we actually mutated labeled services
    if (unlabeledIds.length === 0) {
      if (
        removedDependsOnIds.length === 0 &&
        platformAdjustedIds.length === 0
      ) {
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
          ...cleanedServices,
        },
      };

      await writeComposeFile(updatedComposeFile);

      return {
        success: true,
        updatedIds: [...removedDependsOnIds, ...platformAdjustedIds],
        unmatchedIds: [],
      };
    }

    // Base services: already-labeled services are cleaned + platform-adjusted (except third-party).
    const baseServices: Record<string, RawComposeService> = {
      ...composeJson.services,
      ...cleanedServices,
      ...platformAdjustedLabeledServices,
    };

    const { updatedServices, updatedIds, unmatchedIds } = unlabeledIds.reduce(
      (acc, id) => {
        const service = baseServices?.[id];
        if (!service) {
          throw new Error(`Service ${id} not found`);
        }

        const isThirdParty = THIRD_PARTY_SERVICES.has(id);

        // Normalize labels into string array for manipulation.
        const initialLabels = toLabelStrings(service.labels);

        // THIRD-PARTY: adopt by id only; do not modify env/networks/volumes/depends_on.
        if (isThirdParty) {
          return {
            updatedServices: {
              ...acc.updatedServices,
              [id]: {
                ...service,
                labels: buildFinalLabels(initialLabels, 'third-party', id),
              },
            },
            updatedIds: [...acc.updatedIds, id],
            unmatchedIds: acc.unmatchedIds,
          };
        }

        const { imageName } = parseImage(service.image);

        const agentEntry = (agentsJson.data || []).find(
          (agent: any) => agent.dockerHubRepoName === imageName,
        );

        if (!agentEntry) {
          return {
            updatedServices: {
              ...acc.updatedServices,
              [id]: { ...service, labels: initialLabels },
            },
            updatedIds: acc.updatedIds,
            unmatchedIds: [...acc.unmatchedIds, id],
          };
        }

        // Decide conductor type
        const conductorType: ConductorType | null = (() => {
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

        // Remove depends_on for this service (non-third-party only).
        const { cleanedServices: cleanedSingle } = removeDependsOnFromServices(
          { ...composeJson, services: baseServices },
          [id],
        );

        const cleanedServiceBase = cleanedSingle[id] ?? service;

        const platformAdjustedService: RawComposeService = (() => {
          // Skip conductor service itself
          if (id === conductorServiceName) {
            return cleanedServiceBase;
          }

          const singleServiceMap = { [id]: cleanedServiceBase };

          // Agents: full adjustments. Modules/Core-hub: network only.
          const adjustedMap =
            conductorType === 'agent'
              ? applyPlatformAdjustments(
                  singleServiceMap,
                  [id],
                  isWindows,
                  gluesyncHostDefault,
                  networkName,
                ).services
              : addNetworkToServices(singleServiceMap, [id], networkName)
                  .services;

          return adjustedMap[id] ?? cleanedServiceBase;
        })();

        const finalLabels = buildFinalLabels(initialLabels, conductorType, id);

        // Normalize environment
        const normalizedEnv = extractKeyValue(
          composeServiceFieldConfig.environment.separator,
          platformAdjustedService.environment,
        );

        const envArray = Object.entries(normalizedEnv).map(
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

    // Deduplicate and filter out already-labeled services
    const uniqueUpdatedIds = [...new Set(updatedIds)];
    const newlyAdopted = uniqueUpdatedIds.filter(
      id => !alreadyLabeledIds.includes(id),
    );

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
      updatedIds: [...removedDependsOnIds, ...newlyAdopted],
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
