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
import { mergeServices } from '../composeFile/mergeComposeFiles/mergeComposeFiles';

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
  if (composeJson.networks?.[networkName]) return composeJson;

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
 * Apply platform-specific adjustments:
 * - Windows: add GLUESYNC_HOST to agents + normalize Windows volumes
 * - Non-Windows: normalize volumes
 *
 * Networking is handled once globally via addNetworkToAllServicesExceptConductor.
 */
const applyPlatformAdjustments = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
  isWindows: boolean,
  gluesyncHostDefault: string,
): {
  services: Record<string, RawComposeService>;
  updatedIds: ReadonlyArray<string>;
} => {
  // Step 1: Windows → add GLUESYNC_HOST; Non-Windows → normalize volumes
  const step1 = isWindows
    ? addGluesyncHostToAgents(services, serviceIds, gluesyncHostDefault)
    : addPlatformVolumes(services, serviceIds, false);

  const afterStep1Services: Readonly<Record<string, RawComposeService>> =
    mergeServices([services, step1.services]);

  // Step 2: Windows only → add platform volumes again
  const step2 = isWindows
    ? addPlatformVolumes(afterStep1Services, serviceIds, true)
    : { services: {}, updatedIds: [] as ReadonlyArray<string> };

  const finalServices: Readonly<Record<string, RawComposeService>> =
    mergeServices([afterStep1Services, step2.services]);

  const allUpdatedIds = [
    ...new Set([...step1.updatedIds, ...step2.updatedIds]),
  ] as ReadonlyArray<string>;

  return {
    services: finalServices,
    updatedIds: allUpdatedIds,
  };
};

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

    const windowsNetworkName = 'gluesync-windows-net';
    const linuxNetworkName = 'gluesync-net';
    const networkName = isWindows ? windowsNetworkName : linuxNetworkName;

    // Adoption scope (respects EXCLUDED_SERVICES), but excludes conductor.
    const adoptionServiceIds: readonly string[] = fetchAllServicesInCompose(
      composeJson,
      false,
    ).filter(id => id !== conductorServiceName);

    // Services that ALREADY have a conductor type label
    const alreadyLabeledIds = adoptionServiceIds.filter(id => {
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

    // Apply platform adjustments to already-labeled services (no networking here)
    const {
      services: platformAdjustedLabeledServices,
      updatedIds: platformAdjustedIds,
    } = applyPlatformAdjustments(
      composeJson.services,
      adjustedIds,
      isWindows,
      gluesyncHostDefault,
    );

    // Add env_file to ALL adoption services (only if root folder mounted and .env exists)
    const { services: envFileServices, updatedIds: envFileUpdatedIds } =
      addEnvFileToServices(composeJson.services, adoptionServiceIds);

    // Add network to ALL services present in compose (except conductor)
    const { services: networkAllServices, updatedIds: networkAllUpdatedIds } =
      addNetworkToAllServicesExceptConductor(
        composeJson.services,
        networkName,
        conductorServiceName,
      );

    const unlabeledIds = adoptionServiceIds.filter(
      id => !alreadyLabeledIds.includes(id),
    );

    // CASE A: nothing to adopt; only fix already-labeled services (depends_on/platform/env_file/network)
    if (unlabeledIds.length === 0) {
      if (
        removedDependsOnIds.length === 0 &&
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
            cleanedServices,
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
          ...platformAdjustedIds,
          ...envFileUpdatedIds,
          ...networkAllUpdatedIds,
        ],
        unmatchedIds: [],
      };
    }

    // CASE B: there are unlabeled services to adopt.
    // Base includes: platform adjustments for labeled + env_file + global network for all services.
    const baseServices: Record<string, RawComposeService> = mergeServices([
      composeJson.services,
      platformAdjustedLabeledServices,
      envFileServices,
      networkAllServices,
    ]);

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
          // Conductor excluded from health/network adjustments; keep as-is
          if (id === conductorServiceName) return cleanedServiceBase;

          // Networking is already applied globally in baseServices.
          // Only agents need platform adjustments (GLUESYNC_HOST + volumes).
          if (conductorType !== 'agent') return cleanedServiceBase;

          const singleServiceMap = { [id]: cleanedServiceBase };

          const adjusted = applyPlatformAdjustments(
            singleServiceMap,
            [id],
            isWindows,
            gluesyncHostDefault,
          ).services;

          return adjusted[id] ?? cleanedServiceBase;
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

    // If no newly adopted services and no depends_on was removed and no env_file added and no networks added, bail out
    if (
      updatedIds.length === 0 &&
      removedDependsOnIds.length === 0 &&
      envFileUpdatedIds.length === 0 &&
      networkAllUpdatedIds.length === 0
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
