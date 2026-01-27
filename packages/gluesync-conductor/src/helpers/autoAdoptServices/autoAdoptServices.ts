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
import toLabelStrings from '../../utils/toLabelStrings';
import retagThirdPartyImageToMolo17GA from '../retagThirdPartyImageToMolo17/retagThirdPartyImageToMolo17';
import addEnvFileToServices from '../addEnvFileToServices/addEnvFileToServices';
import { mergeServices } from '../composeFile/mergeComposeFiles/mergeComposeFiles';
import { ConductorServiceTypes } from '../../models/conductor.model';
import removeContainerNameFromServices from '../removeContainerNameFromServices/removeContainerNameFromServices';

/**
 * Ensure the given network exists at the root compose level.
 * To use a named network across services, it must be declared under top-level
 * `networks`, and services must reference it via `services.<svc>.networks`. [web:11][web:64]
 */
const ensureNetworkDefinition = (
  composeJson: any,
  networkName: string,
  isWindows: boolean,
) => {
  if (composeJson.networks?.[networkName]) {
    return composeJson;
  }

  return {
    ...composeJson,
    networks: {
      ...composeJson.networks,
      [networkName]: {
        name: networkName,
        driver: isWindows ? 'nat' : 'bridge',
      },
    },
  };
};

/**
 * Add a network to ALL services in the compose, excluding the conductor.
 * This avoids repeating per-service "addNetworkToServices" calls all over the flow. [web:64]
 */
const addNetworkToAllServicesExceptConductor = (
  services: Readonly<Record<string, RawComposeService>>,
  networkName: string,
  conductorServiceName: string,
): {
  services: Record<string, RawComposeService>;
  updatedIds: ReadonlyArray<string>;
} => {
  const allIdsExceptConductor = Object.keys(services ?? {}).filter(
    id => id !== conductorServiceName,
  );

  return addNetworkToServices(services, allIdsExceptConductor, networkName);
};

/**
 * Apply platform-specific adjustments (GLUESYNC_HOST + network + volumes).
 * - Network is applied only on Windows.
 * - On non-Windows, volumes are still normalized.
 * Returns only the updated services and their ids.
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
  // Step 1: Windows -> add GLUESYNC_HOST to agents; Non-Windows -> normalize volumes
  const step1 = isWindows
    ? addGluesyncHostToAgents(services, serviceIds, gluesyncHostDefault)
    : { services: {}, updatedIds: [] as ReadonlyArray<string> };

  const afterStep1Services: Readonly<Record<string, RawComposeService>> =
    mergeServices([services, step1.services]);

  // Step 2: Network only on Windows
  const step2 = isWindows
    ? addNetworkToServices(afterStep1Services, serviceIds, networkName)
    : { services: {}, updatedIds: [] as ReadonlyArray<string> };

  const finalServices: Readonly<Record<string, RawComposeService>> =
    mergeServices([afterStep1Services, step2.services]);

  const allUpdatedIds = [
    ...new Set([...step1.updatedIds, ...step2.updatedIds]),
  ] as ReadonlyArray<string>;

  return {
    // return the merged map (call sites already overlay this into composeJson.services)
    services: finalServices as Record<string, RawComposeService>,
    updatedIds: allUpdatedIds,
  };
};

const buildFinalLabels = (
  initialLabels: ReadonlyArray<string>,
  conductorType: ConductorServiceTypes,
  serviceId: string,
): ReadonlyArray<string> => {
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
    const conductorServiceName =
      process.env.CONDUCTOR_NAME || 'gluesync-conductor';
    const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

    // Network name is still computed, but applied only on Windows.
    const networkName = isWindows ? 'gluesync-windows-net' : 'gluesync-net';

    // Always include third-party in the scan.
    const allServiceIds: readonly string[] = fetchAllServicesInCompose(
      composeJson,
      false,
      true,
    );

    // Add env_file to ALL services if not windows.
    const { services: envFileServices, updatedIds: envFileUpdatedIds } =
      isWindows
        ? {
            services: {} as Record<string, RawComposeService>,
            updatedIds: [] as string[],
          }
        : addEnvFileToServices(composeJson.services, allServiceIds);

    // Services that ALREADY have a conductor type label
    const alreadyLabeledIds = allServiceIds.filter(id => {
      const service = composeJson.services?.[id];
      if (!service) {
        return false;
      }

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
    const { cleanedServices: cleanedServicesDependsOn, removedDependsOnIds } =
      removeDependsOnFromServices(composeJson, alreadyLabeledIds);

    // Second pass: remove container_name from already-labeled services
    // IMPORTANT: this helper expects an object with `.services`, so thread the previous cleaned map as `.services`.
    const {
      cleanedServices: cleanedServicesContainerName,
      removedContainerNameIds,
    } = removeContainerNameFromServices(
      { ...composeJson, services: cleanedServicesDependsOn },
      alreadyLabeledIds,
    );

    // ComposeJson with both cleaners applied (used as the base for everything below)
    const cleanedComposeJson = {
      ...composeJson,
      services: {
        ...composeJson.services,
        ...cleanedServicesContainerName,
      },
    };

    // Apply platform adjustments to already-labeled services (except third-party)
    const {
      services: platformAdjustedLabeledServices,
      updatedIds: platformAdjustedIds,
    } = applyPlatformAdjustments(
      cleanedComposeJson.services,
      adjustedIds,
      isWindows,
      gluesyncHostDefault,
      networkName,
    );

    // Add network to ALL services present in compose (except conductor)
    // NOTE: compute this early so we can:
    // - include it in the early-exit guard
    // - merge it into baseServices in the unlabeledIds>0 branch
    const { services: networkAllServices, updatedIds: networkAllUpdatedIds } =
      addNetworkToAllServicesExceptConductor(
        composeJson.services,
        networkName,
        conductorServiceName,
      );

    const unlabeledIds = allServiceIds.filter(
      id => !alreadyLabeledIds.includes(id),
    );

    // Nothing new to label: only write file if we actually mutated labeled services
    if (unlabeledIds.length === 0) {
      if (
        removedDependsOnIds.length === 0 &&
        removedContainerNameIds.length === 0 &&
        platformAdjustedIds.length === 0 &&
        envFileUpdatedIds.length === 0 &&
        networkAllUpdatedIds.length === 0
      ) {
        return {
          success: true,
          updatedIds: [],
          unmatchedIds: [],
        };
      }

      const updatedComposeFile = ensureNetworkDefinition(
        {
          ...composeJson,
          services: mergeServices([
            composeJson.services,
            cleanedServicesContainerName,
            platformAdjustedLabeledServices,
            envFileServices,
            networkAllServices,
          ]),
        },
        networkName,
        isWindows,
      );

      await writeComposeFile(updatedComposeFile);

      return {
        success: true,
        updatedIds: [
          ...removedDependsOnIds,
          ...removedContainerNameIds,
          ...platformAdjustedIds,
          ...envFileUpdatedIds,
          ...networkAllUpdatedIds,
        ],
        unmatchedIds: [],
      };
    }

    // Base services: already-labeled services are cleaned + platform-adjusted (except third-party) + env_file
    // IMPORTANT: include networkAllServices here too, otherwise the network changes are dropped on write.
    const baseServices: Record<string, RawComposeService> = mergeServices([
      composeJson.services,
      cleanedServicesContainerName,
      platformAdjustedLabeledServices,
      envFileServices,
      networkAllServices,
    ]);

    type AdoptResult = Readonly<{
      id: string;
      service: RawComposeService;
      updated: boolean;
      unmatched: boolean;
    }>;

    const adoptionResults: ReadonlyArray<AdoptResult> = await Promise.all(
      unlabeledIds.map(async (id): Promise<AdoptResult> => {
        const service = baseServices?.[id];
        if (!service) {
          throw new Error(`Service ${id} not found`);
        }

        const isThirdParty = THIRD_PARTY_SERVICES.has(id);

        // Normalize labels into string array for manipulation.
        const initialLabels = toLabelStrings(service.labels);

        // THIRD-PARTY: adopt by id only; do not modify env/networks/volumes/depends_on.
        // Only allowed change: optional retag to molo17/<repo>:<latestGA> if helper resolves a version.
        if (isThirdParty) {
          const retaggedImage = await retagThirdPartyImageToMolo17GA(
            service.image,
            isWindows,
            process.env.WINDOWS_YEAR,
          );

          return {
            id,
            updated: true,
            unmatched: false,
            service: {
              ...service,
              ...(retaggedImage && {
                image: retaggedImage,
                labels: buildFinalLabels(initialLabels, 'third-party', id),
              }),
            },
          };
        }

        const { imageName } = parseImage(service.image);

        const agentEntry = (agentsJson.data || []).find(
          (agent: any) => agent.dockerHubRepoName === imageName,
        );

        if (!agentEntry) {
          return {
            id,
            updated: false,
            unmatched: true,
            service: { ...service, labels: initialLabels },
          };
        }

        // Decide conductor type
        const conductorType: ConductorServiceTypes | null = (() => {
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
          return {
            id,
            updated: false,
            unmatched: true,
            service: { ...service, labels: initialLabels },
          };
        }

        // Remove depends_on + container_name for this service (non-third-party only).
        const composeForSingle = {
          ...cleanedComposeJson,
          services: baseServices,
        };

        const { cleanedServices: cleanedDependsSingle } =
          removeDependsOnFromServices(composeForSingle, [id]);

        const { cleanedServices: cleanedContainerSingle } =
          removeContainerNameFromServices(
            { ...cleanedComposeJson, services: cleanedDependsSingle },
            [id],
          );

        const cleanedServiceBase = cleanedContainerSingle[id] ?? service;

        const platformAdjustedService: RawComposeService = (() => {
          // Skip conductor service itself
          if (id === conductorServiceName) {
            return cleanedServiceBase;
          }

          const singleServiceMap: Record<string, RawComposeService> = {
            [id]: cleanedServiceBase,
          };

          // Agents: full adjustments. Modules/Core-hub: network only (but network is Windows-only in helpers below).
          const adjustedMap: Record<string, RawComposeService> = (() => {
            if (conductorType === 'agent') {
              return applyPlatformAdjustments(
                singleServiceMap,
                [id],
                isWindows,
                gluesyncHostDefault,
                networkName,
              ).services;
            }

            // Network only on Windows
            if (isWindows) {
              return addNetworkToServices(singleServiceMap, [id], networkName)
                .services;
            }

            return singleServiceMap;
          })();

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
          id,
          updated: true,
          unmatched: false,
          service: {
            ...platformAdjustedService,
            // Preserve env_file if present (added by addEnvFileToServices or originally set)
            env_file: platformAdjustedService.env_file ?? service.env_file,
            labels: finalLabels,
            environment: envArray,
          },
        };
      }),
    );

    const updatedServices: Record<string, RawComposeService> =
      Object.fromEntries(adoptionResults.map(r => [r.id, r.service])) as Record<
        string,
        RawComposeService
      >;

    const updatedIds: ReadonlyArray<string> = adoptionResults
      .filter(r => r.updated)
      .map(r => r.id);

    const unmatchedIds: ReadonlyArray<string> = adoptionResults
      .filter(r => r.unmatched)
      .map(r => r.id);

    // If no newly adopted services and no depends_on was removed and no env_file changes and no network changes, bail out
    if (
      updatedIds.length === 0 &&
      removedDependsOnIds.length === 0 &&
      envFileUpdatedIds.length === 0 &&
      networkAllUpdatedIds.length === 0 &&
      removedContainerNameIds.length === 0
    ) {
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

    const updatedComposeFile = ensureNetworkDefinition(
      {
        ...composeJson,
        services: mergeServices([baseServices, updatedServices]),
      },
      networkName,
      isWindows,
    );

    await writeComposeFile(updatedComposeFile);

    return {
      success: true,
      updatedIds: [
        ...removedDependsOnIds,
        ...removedContainerNameIds,
        ...newlyAdopted,
        ...envFileUpdatedIds,
        ...networkAllUpdatedIds,
      ],
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
