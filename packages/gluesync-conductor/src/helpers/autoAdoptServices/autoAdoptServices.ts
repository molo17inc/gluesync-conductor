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
import addPlatformVolumes from '../addPlatformVolumes/addPlatformVolumes';
import toLabelStrings from '../../utils/toLabelStrings';
import addEnvFileToServices from '../addEnvFileToServices/addEnvFileToServices';

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
  console.log('🔧 applyPlatformAdjustments called with:');
  console.log('   serviceIds:', serviceIds);
  console.log('   isWindows:', isWindows);
  console.log('   gluesyncHostDefault:', gluesyncHostDefault);
  console.log('   windowsNetworkName:', windowsNetworkName);

  const step1 = isWindows
    ? addGluesyncHostToAgents(services, serviceIds, gluesyncHostDefault)
    : addPlatformVolumes(services, serviceIds, false);

  console.log(
    '   Step1 (addGluesyncHost/volumes) updatedIds:',
    step1.updatedIds,
  );

  const afterStep1Services: Readonly<Record<string, RawComposeService>> = {
    ...services,
    ...step1.services,
  };

  const step2 = isWindows
    ? addNetworkToServices(afterStep1Services, serviceIds, windowsNetworkName)
    : { services: {}, updatedIds: [] as ReadonlyArray<string> };

  console.log('   Step2 (addNetwork) updatedIds:', step2.updatedIds);

  const afterStep2Services: Readonly<Record<string, RawComposeService>> = {
    ...afterStep1Services,
    ...step2.services,
  };

  const step3 = isWindows
    ? addPlatformVolumes(afterStep2Services, serviceIds, true)
    : { services: {}, updatedIds: [] as ReadonlyArray<string> };

  console.log('   Step3 (addPlatformVolumes) updatedIds:', step3.updatedIds);

  const finalServices: Readonly<Record<string, RawComposeService>> = {
    ...afterStep2Services,
    ...step3.services,
  };

  const allUpdatedIds: ReadonlyArray<string> = [
    ...step1.updatedIds,
    ...step2.updatedIds,
    ...step3.updatedIds,
  ];

  console.log('   Combined allUpdatedIds:', allUpdatedIds);
  console.log('   Unique allUpdatedIds:', [...new Set(allUpdatedIds)]);

  const changedServices = Object.fromEntries(
    allUpdatedIds.map(id => [id, finalServices[id]]),
  ) as Record<string, RawComposeService>;

  console.log('   changedServices keys:', Object.keys(changedServices));

  return {
    services: changedServices,
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

    const windowsNetworkName = 'gluesync-windows-net';

    const conductorServiceName =
      process.env.CONDUCTOR_NAME || 'gluesync-conductor';

    const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

    // Extract all service IDs without the EXCLUDED_SERVICES
    const allServiceIds: readonly string[] = fetchAllServicesInCompose(
      composeJson,
      false,
    );

    // Services that ALREADY have a conductor type label
    const alreadyLabeledIds = allServiceIds.filter(id => {
      const service = composeJson.services?.[id];
      if (!service) return false;

      // FIX: Use toLabelStrings to handle both array and object formats
      const labelStrings = toLabelStrings(service.labels);

      const hasConductorType = labelStrings.some(label =>
        label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`),
      );

      return hasConductorType;
    });

    // Exclude conductor from platform adjustments
    const adjustedIds = alreadyLabeledIds.filter(
      id => id !== conductorServiceName,
    );

    // LOG 1: Already labeled services
    console.log('🏷️  Already labeled services:', alreadyLabeledIds);

    // LOG 2: Services being adjusted (should exclude conductor)
    console.log('🔧 Services for platform adjustments:', adjustedIds);

    // First pass: remove depends_on
    const { cleanedServices, removedDependsOnIds } =
      removeDependsOnFromServices(composeJson, alreadyLabeledIds);

    // LOG 3: Depends_on removed from
    console.log('🗑️  Removed depends_on from:', removedDependsOnIds);

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

    // LOG 4: Platform adjustments applied to
    console.log('⚙️  Platform adjusted IDs:', platformAdjustedIds);
    console.log(
      '⚙️  Platform adjusted services:',
      Object.keys(platformAdjustedLabeledServices),
    );

    // Add env_file to ALL services (only if root folder mounted and .env exists)
    const { services: envFileServices, updatedIds: envFileUpdatedIds } =
      addEnvFileToServices(composeJson.services, allServiceIds);

    console.log('📋 env_file added to:', envFileUpdatedIds);

    const unlabeledIds = allServiceIds.filter(
      id => !alreadyLabeledIds.includes(id),
    );

    // LOG 5: Unlabeled services
    console.log('🆕 Unlabeled services to adopt:', unlabeledIds);

    if (unlabeledIds.length === 0) {
      console.log('⏭️  Early return path - no unlabeled services');
      console.log('   Returning updatedIds:', [
        ...removedDependsOnIds,
        ...platformAdjustedIds,
        ...envFileUpdatedIds,
      ]);
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

    // From this point on, work on a base services object where
    // already-labeled services are already cleaned from depends_on and have env_file
    const baseServices: Record<string, RawComposeService> = {
      ...composeJson.services,
      ...platformAdjustedLabeledServices,
      ...envFileServices,
    };

    // Second pass: adopt UNLABELED services (and ensure depends_on removed via utility)
    const { updatedServices, updatedIds, unmatchedIds } = unlabeledIds.reduce(
      (acc, id) => {
        const service = baseServices?.[id];
        if (!service) {
          throw new Error(`Service ${id} not found`);
        }

        // FIX: Use toLabelStrings to handle both array and object formats
        const initialLabels = toLabelStrings(service.labels);

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

        const platformAdjustedService: RawComposeService = (() => {
          // Skip conductor → return cleaned base unchanged
          if (id === conductorServiceName) {
            return cleanedServiceBase;
          }

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

        // Derive container_name for services that don't have one
        const existingContainerName = service.container_name;
        const containerName =
          existingContainerName ??
          `${imageName}${
            conductorType === 'agent' ? `-${normalizedEnv.type}` : ''
          }-${conductorType}`;

        return {
          updatedServices: {
            ...acc.updatedServices,
            [id]: {
              ...platformAdjustedService,
              labels: finalLabels,
              environment: envArray,
              container_name: containerName,
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
