import { LabelPrefix } from '../../models/composeFile.model';
import { AddPlatformVolumes } from './AddPlatformVolumes.model';

/**
 * Normalize volumes for services depending on platform.
 * Removes legacy mounts and only returns changed services.
 */
const addPlatformVolumes: AddPlatformVolumes = (
  services,
  serviceIds,
  isWindows,
) => {
  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
  const conductorName = process.env.CONDUCTOR_NAME || 'gluesync-conductor';

  // Helper to normalize volume for comparison (strip mount options like :ro, :rw)
  const stripMountOptions = (vol: string): string => vol.replace(/:r[ow]$/, '');

  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const svc = services[id];
      if (!svc) return acc;

      // Skip core-hub and conductor - autoheal will handle them
      if (id === coreHubName || id === conductorName) {
        return acc;
      }

      // Check if service is an agent (has conductor.type=agent label)
      const isAgent = Array.isArray(svc.labels)
        ? svc.labels.some(l =>
            l.includes(`${LabelPrefix.CONDUCTOR}.type=agent`),
          )
        : Object.entries(svc.labels || {}).some(
            ([k, v]) => k === `${LabelPrefix.CONDUCTOR}.type` && v === 'agent',
          );

      // ✅ Only normalize agents - skip modules (they have custom paths)
      if (!isAgent) {
        return acc;
      }

      const containerName = svc.container_name || id;

      const normalizedVolumes = isWindows
        ? [
            `./shared:C:\\opt\\gluesync\\shared:ro`, // ✅ Keep :ro for agents
            `./data/${containerName}:C:\\opt\\gluesync\\data`,
            `./logs/${containerName}:C:\\opt\\gluesync\\logs`,
          ]
        : [
            `./shared:/opt/gluesync/shared:ro`,
            `./data/${containerName}:/opt/gluesync/data`,
            `./logs/${containerName}:/opt/gluesync/logs`,
          ];

      // Remove ALL data/logs/shared volumes and keep everything else
      const otherVolumes = (svc.volumes || []).filter(
        v =>
          !v.startsWith('./data/') &&
          !v.startsWith('./logs/') &&
          !v.includes('\\data\\') &&
          !v.includes('\\logs\\') &&
          !v.startsWith('./shared') &&
          !v.includes('\\shared'),
      );

      // Combine: other volumes + all normalized volumes
      const nextVolumes = [...otherVolumes, ...normalizedVolumes];

      // Compare semantically (ignore :ro differences during comparison)
      const currentNormalized = (svc.volumes || [])
        .map(stripMountOptions)
        .sort();
      const nextNormalized = nextVolumes.map(stripMountOptions).sort();

      const volumesChanged =
        currentNormalized.length !== nextNormalized.length ||
        !currentNormalized.every((v, i) => v === nextNormalized[i]);

      if (!volumesChanged) {
        return acc;
      }

      return {
        updatedServices: {
          ...acc.updatedServices,
          [id]: { ...svc, volumes: nextVolumes },
        },
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

export default addPlatformVolumes;
