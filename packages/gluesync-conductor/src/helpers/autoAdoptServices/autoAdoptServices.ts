import {
  composeServiceFieldConfig,
  LabelPrefix,
  RawComposeFile,
  RawComposeService,
} from '../../models/composeFile.model';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAllServicesInCompose from '../fetchAllServicesInCompose/fetchAllServicesInCompose';
import { THIRD_PARTY_SERVICES } from '../fetchAllServicesInCompose/fetchAllServicesInCompose.model';
import parseImage from '../parseImage/parseImage';
import { inferTypeFromAgentsJson } from '../inferServiceType/inferServiceType';
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
import addGluesyncHostToChronos from '../addGluesyncHostToChronos/addGluesyncHostToChronos';
import applyCoreHubProductionTweaks from '../applyCoreHubProductionTweaks/applyCoreHubProductionTweaks';
import addEnvToGrafana from '../addEnvToGrafana/addEnvToGrafana';
import applyCpuCompatibilityToImage from '../applyCpuCompatibilityToImage/applyCpuCompatibilityToImage';
import addPortToCoreHub from '../addPortToCoreHub/addPortToCoreHub';
import healTraefikConf, {
  findProxyServiceName,
} from '../healTraefikConf/healTraefikConf';
import recreateChronosContainers from '../healChronosTraefikRule/healChronosTraefikRule';
import { rewriteChronosRouterLabels } from '../healChronosTraefikRule/chronosRouterRule';

/**
 * Ensure the given network exists at the root compose level.
 * To use a named network across services, it must be declared under top-level
 * `networks`, and services must reference it via `services.<svc>.networks`.
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
 * This avoids repeating per-service "addNetworkToServices" calls all over the flow.
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

export const hasConductorTypeLabel = (
  service:
    | Readonly<{ labels?: NonNullable<Parameters<typeof toLabelStrings>[0]> }>
    | undefined,
): boolean => {
  if (!service) {
    return false;
  }

  return toLabelStrings(service.labels).some(label =>
    label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`),
  );
};
type ComposeJson = Partial<RawComposeFile>;
type ServiceMap = Record<string, RawComposeService>;

type AdoptResult = Readonly<{
  id: string;
  service: RawComposeService;
  updated: boolean;
  unmatched: boolean;
}>;

type AdoptContext = Readonly<{
  baseServices: ServiceMap;
  cleanedComposeJson: ComposeJson;
  conductorServiceName: string;
  gluesyncHostDefault: string;
  isWindows: boolean;
  networkName: string;
}>;

/**
 * Heal the Chronos router labels and return the compose to continue with.
 * The healed services are only used when something was actually rewritten.
 */
const healChronosRouters = (
  readComposeJson: ComposeJson,
): { composeJson: ComposeJson; chronosUpdatedIds: ReadonlyArray<string> } => {
  const chronosRuleHeal = rewriteChronosRouterLabels(readComposeJson.services);
  const composeJson =
    chronosRuleHeal.updatedIds.length > 0 && readComposeJson.services
      ? {
          ...readComposeJson,
          services: chronosRuleHeal.services,
        }
      : readComposeJson;

  return { composeJson, chronosUpdatedIds: chronosRuleHeal.updatedIds };
};

/** True when every given list of ids is empty (nothing changed). */
const allEmpty = (lists: ReadonlyArray<ReadonlyArray<string>>): boolean =>
  lists.every(list => list.length === 0);

/**
 * Write the compose file and, when Chronos routers were healed, recreate the
 * Chronos containers so the new rules take effect.
 */
const writeAndRecreateChronos = async (
  updatedComposeFile: ReturnType<typeof ensureNetworkDefinition>,
  chronosUpdatedIds: ReadonlyArray<string>,
  composeJson: ComposeJson,
): Promise<void> => {
  await writeComposeFile(updatedComposeFile);

  if (chronosUpdatedIds.length > 0) {
    await recreateChronosContainers(
      chronosUpdatedIds,
      findProxyServiceName(composeJson),
    );
  }
};

/**
 * Third-party services are adopted by id; the only change allowed is the
 * Molo17 retag of the image (labels are added alongside it).
 */
const adoptThirdPartyService = async (
  id: string,
  service: RawComposeService,
  initialLabels: ReadonlyArray<string>,
  isWindows: boolean,
): Promise<AdoptResult> => {
  const { fullName } = parseImage(service.image);

  // already retagged image
  if (fullName?.startsWith('molo17')) {
    return {
      id,
      updated: true,
      unmatched: false,
      service: {
        ...service,
        labels: buildFinalLabels(initialLabels, 'third-party', id),
      },
    };
  }

  // if here the third-party image needs a retag
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
};

/**
 * Agents: full adjustments. Modules/Core-hub: network only (but network is
 * Windows-only in the helpers below).
 */
const adjustServiceMap = (
  singleServiceMap: Record<string, RawComposeService>,
  id: string,
  conductorType: ConductorServiceTypes,
  ctx: AdoptContext,
): Record<string, RawComposeService> => {
  if (conductorType === 'agent') {
    return applyPlatformAdjustments(
      singleServiceMap,
      [id],
      ctx.isWindows,
      ctx.gluesyncHostDefault,
      ctx.networkName,
    ).services;
  }

  // Network only on Windows
  if (ctx.isWindows) {
    return addNetworkToServices(singleServiceMap, [id], ctx.networkName)
      .services;
  }

  return singleServiceMap;
};

const adjustManagedService = (
  id: string,
  cleanedServiceBase: RawComposeService,
  conductorType: ConductorServiceTypes,
  ctx: AdoptContext,
): RawComposeService => {
  // Skip conductor service itself
  if (id === ctx.conductorServiceName) {
    return cleanedServiceBase;
  }

  const adjustedMap = adjustServiceMap(
    { [id]: cleanedServiceBase },
    id,
    conductorType,
    ctx,
  );

  return adjustedMap[id] ?? cleanedServiceBase;
};

/**
 * Remove depends_on + container_name for a single (non-third-party) service.
 */
const cleanSingleService = (
  id: string,
  service: RawComposeService,
  ctx: AdoptContext,
): RawComposeService => {
  const composeForSingle = {
    ...ctx.cleanedComposeJson,
    services: ctx.baseServices,
  };

  const { cleanedServices: cleanedDependsSingle } = removeDependsOnFromServices(
    composeForSingle,
    [id],
  );

  const { cleanedServices: cleanedContainerSingle } =
    removeContainerNameFromServices(
      { ...ctx.cleanedComposeJson, services: cleanedDependsSingle },
      [id],
    );

  return cleanedContainerSingle[id] ?? service;
};

/**
 * Adopt a non-third-party service: infer its type, clean + adjust it and label it.
 * Services whose image is unknown are reported as unmatched.
 */
const adoptManagedService = (
  id: string,
  service: RawComposeService,
  initialLabels: ReadonlyArray<string>,
  ctx: AdoptContext,
): AdoptResult => {
  const { imageName } = parseImage(service.image);

  // Same decision swarm mode makes on read (inferServiceType)
  const conductorType = inferTypeFromAgentsJson(imageName);

  if (!conductorType) {
    return {
      id,
      updated: false,
      unmatched: true,
      service: { ...service, labels: initialLabels },
    };
  }

  const platformAdjustedService = adjustManagedService(
    id,
    cleanSingleService(id, service, ctx),
    conductorType,
    ctx,
  );

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
      labels: buildFinalLabels(initialLabels, conductorType, id),
      environment: envArray,
    },
  };
};

const adoptService = async (
  id: string,
  ctx: AdoptContext,
): Promise<AdoptResult> => {
  const service = ctx.baseServices?.[id];
  if (!service) {
    throw new Error(`Service ${id} not found`);
  }

  // Normalize labels into string array for manipulation.
  const initialLabels = toLabelStrings(service.labels);

  if (THIRD_PARTY_SERVICES.has(id)) {
    return adoptThirdPartyService(id, service, initialLabels, ctx.isWindows);
  }

  return adoptManagedService(id, service, initialLabels, ctx);
};

/** Split the per-service results into the services map and the id lists. */
const summarizeAdoption = (
  adoptionResults: ReadonlyArray<AdoptResult>,
): {
  updatedServices: ServiceMap;
  updatedIds: ReadonlyArray<string>;
  unmatchedIds: ReadonlyArray<string>;
} => ({
  updatedServices: Object.fromEntries(
    adoptionResults.map(r => [r.id, r.service]),
  ) as ServiceMap,
  updatedIds: adoptionResults.filter(r => r.updated).map(r => r.id),
  unmatchedIds: adoptionResults.filter(r => r.unmatched).map(r => r.id),
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Environment-driven settings of the adoption run. */
const readEnvConfig = (): {
  gluesyncHostDefault: string;
  conductorServiceName: string;
  isWindows: boolean;
  networkName: string;
} => {
  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

  return {
    gluesyncHostDefault: process.env.GLUESYNC_HOST ?? 'gluesync-core-hub',
    conductorServiceName: process.env.CONDUCTOR_NAME || 'gluesync-conductor',
    isWindows,
    // Network name is still computed, but applied only on Windows.
    networkName: isWindows ? 'gluesync-windows-net' : 'gluesync-net',
  };
};

const emptyResult = (
  unmatchedIds: readonly string[] = [],
): {
  success: boolean;
  updatedIds: readonly string[];
  unmatchedIds: readonly string[];
} => ({
  success: true,
  updatedIds: [],
  unmatchedIds,
});

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
    const { composeJson, chronosUpdatedIds } = healChronosRouters(
      await readComposeFile({ raw: true }),
    );

    if (!composeJson.services) {
      return emptyResult();
    }

    const healedProxyId = await healTraefikConf(composeJson);

    const traefikUpdatedIds = healedProxyId ? [healedProxyId] : [];

    const {
      gluesyncHostDefault,
      conductorServiceName,
      isWindows,
      networkName,
    } = readEnvConfig();

    // Always include third-party in the scan.
    const allServiceIds: readonly string[] = fetchAllServicesInCompose(
      composeJson,
      false,
      true,
    );

    // Remove depends_on + container_name for ALL services except conductor
    const idsToClean = allServiceIds.filter(id => id !== conductorServiceName);

    // First pass: remove depends_on from already-labeled services
    const { cleanedServices: cleanedServicesDependsOn, removedDependsOnIds } =
      removeDependsOnFromServices(composeJson, idsToClean);

    // Second pass: remove container_name from already-labeled services
    // IMPORTANT: this helper expects an object with `.services`, so thread the previous cleaned map as `.services`.
    const {
      cleanedServices: cleanedServicesContainerName,
      removedContainerNameIds,
    } = removeContainerNameFromServices(
      { ...composeJson, services: cleanedServicesDependsOn },
      idsToClean,
    );

    // ComposeJson with both cleaners applied (used as the base for everything below)
    const cleanedComposeJson = {
      ...composeJson,
      services: {
        ...composeJson.services,
        ...cleanedServicesContainerName,
      },
    };

    const stepChronos = addGluesyncHostToChronos(
      cleanedComposeJson.services,
      'https://gluesync-core-hub:1717',
    );

    const stepGrafana = addEnvToGrafana(cleanedComposeJson.services);

    const servicesWithChronosHost = mergeServices([
      cleanedComposeJson.services,
      stepChronos.services,
      stepGrafana.services,
    ]);

    // Add env_file to ALL services
    const { services: envFileServices, updatedIds: envFileUpdatedIds } =
      addEnvFileToServices(servicesWithChronosHost, allServiceIds);

    // Services that ALREADY have a conductor type label
    const alreadyLabeledIds = allServiceIds.filter(id =>
      hasConductorTypeLabel(servicesWithChronosHost?.[id]),
    );

    // Exclude conductor + third-party from platform adjustments.
    const adjustedIds = alreadyLabeledIds.filter(
      id => id !== conductorServiceName && !THIRD_PARTY_SERVICES.has(id),
    );

    // Apply platform adjustments to already-labeled services (except third-party)
    const {
      services: platformAdjustedLabeledServices,
      updatedIds: platformAdjustedIds,
    } = applyPlatformAdjustments(
      servicesWithChronosHost,
      adjustedIds,
      isWindows,
      gluesyncHostDefault,
      networkName,
    );

    const { services: coreHubTweakedServices, updatedIds: coreHubTweakedIds } =
      applyCoreHubProductionTweaks(
        platformAdjustedLabeledServices,
        adjustedIds,
        isWindows,
      );

    // CPU compatibility (Linux only) - apply to already-labeled services
    const {
      services: cpuCompatibleLabeledServices,
      updatedIds: cpuCompatibilityLabeledIds,
    } = await applyCpuCompatibilityToImage(
      coreHubTweakedServices,
      adjustedIds,
      isWindows,
    );

    // Add network to ALL services present in compose (except conductor)
    // NOTE: compute this early so we can:
    // - include it in the early-exit guard
    // - merge it into baseServices in the unlabeledIds>0 branch
    const { services: networkAllServices, updatedIds: networkAllUpdatedIds } =
      addNetworkToAllServicesExceptConductor(
        servicesWithChronosHost,
        networkName,
        conductorServiceName,
      );

    const unlabeledIds = allServiceIds.filter(
      id => !alreadyLabeledIds.includes(id),
    );

    // Nothing new to label: only write file if we actually mutated labeled services
    if (unlabeledIds.length === 0) {
      const {
        services: portAddedLabeledServices,
        updatedIds: portAddedLabeledIds,
      } = addPortToCoreHub(cpuCompatibleLabeledServices, adjustedIds);

      if (
        allEmpty([
          removedDependsOnIds,
          removedContainerNameIds,
          platformAdjustedIds,
          envFileUpdatedIds,
          networkAllUpdatedIds,
          stepChronos.updatedIds,
          stepGrafana.updatedIds,
          coreHubTweakedIds,
          cpuCompatibilityLabeledIds,
          portAddedLabeledIds,
          chronosUpdatedIds,
          traefikUpdatedIds,
        ])
      ) {
        return emptyResult();
      }

      await writeAndRecreateChronos(
        ensureNetworkDefinition(
          {
            ...composeJson,
            services: mergeServices([
              servicesWithChronosHost,
              platformAdjustedLabeledServices,
              envFileServices,
              networkAllServices,
              coreHubTweakedServices,
              cpuCompatibleLabeledServices,
              portAddedLabeledServices,
            ]),
          },
          networkName,
          isWindows,
        ),
        chronosUpdatedIds,
        composeJson,
      );

      return {
        success: true,
        updatedIds: [
          ...removedDependsOnIds,
          ...removedContainerNameIds,
          ...platformAdjustedIds,
          ...envFileUpdatedIds,
          ...networkAllUpdatedIds,
          ...stepChronos.updatedIds,
          ...stepGrafana.updatedIds,
          ...coreHubTweakedIds,
          ...cpuCompatibilityLabeledIds,
          ...portAddedLabeledIds,
          ...chronosUpdatedIds,
          ...traefikUpdatedIds,
        ],
        unmatchedIds: [],
      };
    }

    // Base services: already-labeled services are cleaned + platform-adjusted (except third-party) + env_file
    // IMPORTANT: include networkAllServices here too, otherwise the network changes are dropped on write.
    const baseServicesPreTweaks: ServiceMap = mergeServices([
      servicesWithChronosHost,
      platformAdjustedLabeledServices,
      envFileServices,
      networkAllServices,
    ]);

    const { services: baseServices } = applyCoreHubProductionTweaks(
      baseServicesPreTweaks,
      allServiceIds,
      isWindows,
    );

    const ctx: AdoptContext = {
      baseServices,
      cleanedComposeJson,
      conductorServiceName,
      gluesyncHostDefault,
      isWindows,
      networkName,
    };

    const adoptionResults = await Promise.all(
      unlabeledIds.map(id => adoptService(id, ctx)),
    );

    const { updatedServices, updatedIds, unmatchedIds } =
      summarizeAdoption(adoptionResults);

    // If no newly adopted services and no depends_on was removed and no env_file changes and no network changes, bail out
    if (
      allEmpty([
        updatedIds,
        removedDependsOnIds,
        envFileUpdatedIds,
        networkAllUpdatedIds,
        removedContainerNameIds,
        chronosUpdatedIds,
        traefikUpdatedIds,
      ])
    ) {
      return emptyResult(unmatchedIds);
    }

    // Deduplicate and filter out already-labeled services
    const uniqueUpdatedIds = [...new Set(updatedIds)];
    const newlyAdopted = uniqueUpdatedIds.filter(
      id => !alreadyLabeledIds.includes(id),
    );

    // Merge base services with newly adopted services
    const mergedServices = mergeServices([baseServices, updatedServices]);

    // CPU compatibility (Linux only) - apply to all services
    const {
      services: cpuCompatibleServices,
      updatedIds: cpuCompatibilityUpdatedIds,
    } = await applyCpuCompatibilityToImage(
      mergedServices,
      allServiceIds,
      isWindows,
    );

    const { services: portAddedServices, updatedIds: portAddedIds } =
      addPortToCoreHub(cpuCompatibleServices, allServiceIds);

    await writeAndRecreateChronos(
      ensureNetworkDefinition(
        {
          ...composeJson,
          services: portAddedServices,
        },
        networkName,
        isWindows,
      ),
      chronosUpdatedIds,
      composeJson,
    );

    return {
      success: true,
      updatedIds: [
        ...removedDependsOnIds,
        ...removedContainerNameIds,
        ...newlyAdopted,
        ...envFileUpdatedIds,
        ...networkAllUpdatedIds,
        ...cpuCompatibilityUpdatedIds,
        ...portAddedIds,
        ...chronosUpdatedIds,
        ...traefikUpdatedIds,
      ],
      unmatchedIds,
    };
  } catch (error) {
    console.error(`Failed to apply Conductor labels: ${errorMessage(error)}`);
    return {
      success: false,
      updatedIds: [],
      unmatchedIds: [],
    };
  }
};

export default autoAdoptServices;
