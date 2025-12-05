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

      const filteredExisting = (svc.volumes || []).filter(
        v => !v.startsWith('./data/target') && !v.startsWith('./logs/target'),
      );

      const nextVolumes = [...filteredExisting, ...normalizedVolumes];

      // Compare sets instead of JSON strings (order-insensitive)
      const sameVolumes =
        svc.volumes?.length === nextVolumes.length &&
        svc.volumes.every(v => nextVolumes.includes(v));

      if (sameVolumes) {
        // No change
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
