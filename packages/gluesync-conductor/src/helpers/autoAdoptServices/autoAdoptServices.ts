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

    // Add env_file to ALL services (helper decides applicability).
    // Compose supports env_file as a string/list/objects; preserve existing values if present. [web:28]
    const { services: envFileServices, updatedIds: envFileUpdatedIds } =
      addEnvFileToServices(composeJson.services, allServiceIds);

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
        platformAdjustedIds.length === 0 &&
        envFileUpdatedIds.length === 0
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
          ...envFileServices,
        },
      };

      await writeComposeFile(updatedComposeFile);

      return {
        success: true,
        updatedIds: [
          ...removedDependsOnIds,
          ...platformAdjustedIds,
          ...envFileUpdatedIds,
        ],
        unmatchedIds: [],
      };
    }

    // Base services: already-labeled services are cleaned + platform-adjusted (except third-party) + env_file
    const baseServices: Record<string, RawComposeService> = {
      ...composeJson.services,
      ...cleanedServices,
      ...platformAdjustedLabeledServices,
      ...envFileServices,
    };

    type AdoptResult = Readonly<{
      id: string;
      service: RawComposeService;
      updated: boolean;
      unmatched: boolean;
    }>;

    const adoptionResults: ReadonlyArray<AdoptResult> = await Promise.all(
      unlabeledIds.map(async (id): Promise<AdoptResult> => {
        const service = baseServices?.[id];
        if (!service) throw new Error(`Service ${id} not found`);

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
          if (agentEntry.dockerHubRepoName === 'gluesync-core-hub')
            return 'core-hub';

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

    // If no newly adopted services and no depends_on was removed and no env_file changes, bail out
    if (
      updatedIds.length === 0 &&
      removedDependsOnIds.length === 0 &&
      envFileUpdatedIds.length === 0
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
      updatedIds: [
        ...removedDependsOnIds,
        ...newlyAdopted,
        ...envFileUpdatedIds,
      ],
      unmatchedIds,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
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
