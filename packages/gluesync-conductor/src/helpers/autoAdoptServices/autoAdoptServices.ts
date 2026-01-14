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
import addPlatformVolumes from '../addPlatformVolumes/addPlatformVolumes';
import toLabelStrings from '../../utils/toLabelStrings';
import addEnvFileToServices from '../addEnvFileToServices/addEnvFileToServices';

/**
 * Merge "patch" service maps into a base service map, per-service.
 *
 * This avoids brittle "spread order" bugs where whole-service snapshots overwrite
 * each other (e.g., volumes vs env_file). Later patches win only for the keys
 * they actually set.
 */
const mergeServices = (
  base: Readonly<Record<string, RawComposeService>>,
  ...patches: ReadonlyArray<Readonly<Record<string, RawComposeService>>>
): Record<string, RawComposeService> => {
  const out: Record<string, RawComposeService> = { ...base };

  for (const patch of patches) {
    for (const [id, patchSvc] of Object.entries(patch)) {
      const prev = out[id];
      if (!prev) {
        out[id] = patchSvc;
        continue;
      }
      out[id] = { ...prev, ...patchSvc };
    }
  }

  return out;
};

/**
 * Apply platform-specific adjustments (GLUESYNC_HOST + network + volumes).
 * On non-Windows, only volumes are normalized.
 * Returns only the updated services and their ids.
 */
const applyPlatformAdjustments = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
  isWindows: boolean,
  gluesyncHostDefault: string,
  windowsNetworkName: string,
): {
  services: Record<string, RawComposeService>;
  updatedIds: ReadonlyArray<string>;
} => {
  // Step 1: Windows → add GLUESYNC_HOST to agents; Non-Windows → normalize volumes
  const step1 = isWindows
    ? addGluesyncHostToAgents(services, serviceIds, gluesyncHostDefault)
    : addPlatformVolumes(services, serviceIds, false);

  const afterStep1Services: Readonly<Record<string, RawComposeService>> =
    mergeServices(services, step1.services);

  // Step 2: Windows only → add network
  const step2 = isWindows
    ? addNetworkToServices(afterStep1Services, serviceIds, windowsNetworkName)
    : { services: {}, updatedIds: [] as ReadonlyArray<string> };

  const afterStep2Services: Readonly<Record<string, RawComposeService>> =
    mergeServices(afterStep1Services, step2.services);

  // Step 3: Windows only → add platform volumes again
  const step3 = isWindows
    ? addPlatformVolumes(afterStep2Services, serviceIds, true)
    : { services: {}, updatedIds: [] as ReadonlyArray<string> };

  const finalServices: Readonly<Record<string, RawComposeService>> =
    mergeServices(afterStep2Services, step3.services);

  const allUpdatedIds = [
    ...new Set([...step1.updatedIds, ...step2.updatedIds, ...step3.updatedIds]),
  ] as ReadonlyArray<string>;

  return {
    services: finalServices,
    updatedIds: allUpdatedIds,
  };
};

/**
 * Function to apply Conductor labels to services in docker-compose.yml.
 * Services with type labels will be handled by Conductor.
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
    const windowsNetworkName = 'gluesync-windows-net';
    const conductorServiceName =
      process.env.CONDUCTOR_NAME || 'gluesync-conductor';
    const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

    // Extract all service IDs without the EXCLUDED_SERVICES
    const allServiceIds: readonly string[] = fetchAllServicesInCompose(
      composeJson,
      false,
    ).filter(id => id !== conductorServiceName);

    // Services that ALREADY have a conductor type label
    const alreadyLabeledIds = allServiceIds.filter(id => {
      const service = composeJson.services?.[id];
      if (!service) return false;

      const labelStrings = toLabelStrings(service.labels);
      return labelStrings.some(label =>
        label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`),
      );
    });

    // Exclude conductor from platform adjustments
    const adjustedIds = alreadyLabeledIds.filter(
      id => id !== conductorServiceName,
    );

    // First pass: remove depends_on for already-labeled services
    const { cleanedServices, removedDependsOnIds } =
      removeDependsOnFromServices(composeJson, alreadyLabeledIds);

    const {
      services: platformAdjustedLabeledServices,
      updatedIds: platformAdjustedIds,
    } = applyPlatformAdjustments(
      composeJson.services,
      adjustedIds,
      isWindows,
      gluesyncHostDefault,
      windowsNetworkName,
    );

    // Add env_file to ALL services (only if root folder mounted and .env exists)
    const { services: envFileServices, updatedIds: envFileUpdatedIds } =
      addEnvFileToServices(composeJson.services, allServiceIds);

    const unlabeledIds = allServiceIds.filter(
      id => !alreadyLabeledIds.includes(id),
    );

    // CASE A: nothing to adopt; only fix already-labeled services (depends_on/network/volumes/env_file)
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

      // IMPORTANT: merge per-service patches, not whole-service snapshots. [web:38]
      const updatedComposeFile = {
        ...composeJson,
        services: mergeServices(
          composeJson.services,
          cleanedServices,
          platformAdjustedLabeledServices,
          envFileServices,
        ),
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

    // CASE B: there are unlabeled services to adopt.
    // Base services = original + (labeled platform adjustments) + (env_file injections) [web:38]
    const baseServices: Record<string, RawComposeService> = mergeServices(
      composeJson.services,
      platformAdjustedLabeledServices,
      envFileServices,
    );

    // Second pass: adopt UNLABELED services
    const { updatedServices, updatedIds, unmatchedIds } = unlabeledIds.reduce(
      (acc, id) => {
        const service = baseServices?.[id];
        if (!service) throw new Error(`Service ${id} not found`);

        const initialLabels = toLabelStrings(service.labels);
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

        const conductorType: string | null = (() => {
          if (agentEntry.dockerHubRepoName === 'gluesync-core-hub')
            return 'core-hub';

          const isTargetValid = typeof agentEntry.isTarget === 'boolean';
          const isSourceValid = typeof agentEntry.isSource === 'boolean';

          if (isTargetValid && isSourceValid) {
            if (agentEntry.isTarget || agentEntry.isSource) return 'agent';
            return 'module';
          }

          return null;
        })();

        if (!conductorType) {
          return {
            updatedServices: {
              ...acc.updatedServices,
              [id]: { ...service, labels: initialLabels },
            },
            updatedIds: acc.updatedIds,
            unmatchedIds: [...acc.unmatchedIds, id],
          };
        }

        // Drop depends_on for this service
        const { cleanedServices: cleanedSingle } = removeDependsOnFromServices(
          { ...composeJson, services: baseServices },
          [id],
        );

        const cleanedServiceBase = cleanedSingle[id] ?? service;

        const platformAdjustedService: RawComposeService = (() => {
          if (id === conductorServiceName) return cleanedServiceBase;

          const singleServiceMap = { [id]: cleanedServiceBase };

          const adjustedServices: Record<string, RawComposeService> =
            conductorType === 'agent'
              ? applyPlatformAdjustments(
                  singleServiceMap,
                  [id],
                  isWindows,
                  gluesyncHostDefault,
                  windowsNetworkName,
                ).services
              : addNetworkToServices(singleServiceMap, [id], windowsNetworkName)
                  .services;

          return adjustedServices[id] ?? cleanedServiceBase;
        })();

        const finalLabels = [
          ...initialLabels,
          `${LabelPrefix.CONDUCTOR}.type=${conductorType}`,
          ...(conductorType === 'agent'
            ? [`${LabelPrefix.CONDUCTOR}.service_id=${id}`]
            : []),
        ];

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
              // Preserve env_file already injected into baseServices for this service (if any)
              env_file: service.env_file,
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

    // If no newly adopted services and no depends_on was removed and no env_file added, bail out
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
      services: mergeServices(baseServices, updatedServices),
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
