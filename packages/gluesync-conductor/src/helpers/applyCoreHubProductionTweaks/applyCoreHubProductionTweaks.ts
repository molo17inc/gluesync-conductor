import { RawComposeService } from '../../models/composeFile.model';
import { ApplyCoreHubProductionTweaks } from './applyCoreHubProductionTweaks.model';

/**
 * Apply production sysctls + ulimits to core-hub only on Linux.
 * Only modifies services where the fields are missing or different.
 * Returns updated services map and list of updated ids (empty if no changes).
 */
const applyCoreHubProductionTweaks: ApplyCoreHubProductionTweaks = (
  services,
  serviceIds,
  isWindows,
) => {
  if (isWindows) {
    return { services, updatedIds: [] as ReadonlyArray<string> };
  }

  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';

  const desiredSysctls = [
    'net.core.somaxconn=65535',
    'net.ipv4.tcp_max_syn_backlog=65535',
    'net.ipv4.tcp_fin_timeout=15',
  ] as ReadonlyArray<string>;

  const desiredUlimits = {
    nofile: {
      soft: 262144,
      hard: 1048576,
    },
  } as const;

  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const svc = services[id];
      if (!svc) {
        return acc;
      }

      // Only target the core-hub service by id
      if (id !== coreHubName) {
        return acc;
      }

      const existingSysctls =
        (svc as { sysctls?: ReadonlyArray<string> }).sysctls ?? [];
      const existingUlimits = (svc as { ulimits?: any }).ulimits ?? {};

      const sysctlsEqual =
        Array.isArray(existingSysctls) &&
        existingSysctls.length === desiredSysctls.length &&
        desiredSysctls.every((s, i) => existingSysctls[i] === s);

      const ulimitsEqual =
        typeof existingUlimits === 'object' &&
        existingUlimits?.nofile?.soft === desiredUlimits.nofile.soft &&
        existingUlimits?.nofile?.hard === desiredUlimits.nofile.hard;

      if (sysctlsEqual && ulimitsEqual) {
        // Already has desired settings → no change
        return acc;
      }

      const nextService: RawComposeService = {
        ...svc,
        sysctls: desiredSysctls,
        ulimits: desiredUlimits as any,
      };

      return {
        updatedServices: { ...acc.updatedServices, [id]: nextService },
        updatedIds: [...acc.updatedIds, id],
      };
    },
    { updatedServices: {}, updatedIds: [] as ReadonlyArray<string> },
  );

  return {
    services:
      updatedIds.length === 0 ? services : { ...services, ...updatedServices },
    updatedIds,
  };
};

export default applyCoreHubProductionTweaks;
