import { RawComposeService } from '../../models/composeFile.model';
import { AddPlatformVolumes } from './AddPlatformVolumes.model';

/**
 * Normalize volumes for services depending on platform.
 * - Windows: ./shared, ./data/<containerName>, ./logs/<containerName>
 * - Linux:   ./shared, ./data/<containerName>, ./logs/<containerName>
 * Removes legacy mounts like ./data/target and ./logs/target.
 * Returns only changed service IDs.
 */
const addPlatformVolumes: AddPlatformVolumes = (
  services,
  serviceIds,
  isWindows,
) => {
  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const svc = services[id];
      if (!svc) return acc;

      const containerName = svc.container_name || id;

      const normalizedVolumes = isWindows
        ? [
            `./shared:C:\\opt\\gluesync\\shared`,
            `./data/${containerName}:C:\\opt\\gluesync\\data`,
            `./logs/${containerName}:C:\\opt\\gluesync\\logs`,
          ]
        : [
            `./shared:/opt/gluesync/shared:ro`,
            `./data/${containerName}:/opt/gluesync/data`,
            `./logs/${containerName}:/opt/gluesync/logs`,
          ];

      // Filter out legacy mounts
      const filteredExisting = (svc.volumes || []).filter(
        v => !v.startsWith('./data/target') && !v.startsWith('./logs/target'),
      );

      const nextVolumes = [...filteredExisting, ...normalizedVolumes];

      // If volumes are unchanged, skip
      const volumesChanged =
        JSON.stringify(nextVolumes) !== JSON.stringify(svc.volumes);

      if (!volumesChanged) {
        return acc;
      }

      const nextService: RawComposeService = {
        ...svc,
        volumes: nextVolumes,
      };

      return {
        updatedServices: {
          ...acc.updatedServices,
          [id]: nextService,
        },
        updatedIds: [...acc.updatedIds, id],
      };
    },
    {
      updatedServices: {} as Record<string, RawComposeService>,
      updatedIds: [] as ReadonlyArray<string>,
    },
  );

  return {
    services:
      updatedIds.length === 0 ? services : { ...services, ...updatedServices },
    updatedIds,
  };
};

export default addPlatformVolumes;
