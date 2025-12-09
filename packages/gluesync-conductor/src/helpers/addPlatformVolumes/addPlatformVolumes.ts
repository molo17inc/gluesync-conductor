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
  const conductorServiceName =
    process.env.CONDUCTOR_NAME || 'gluesync-conductor';

  console.log('📦 addPlatformVolumes called');
  console.log('   isWindows:', isWindows);
  console.log('   serviceIds:', serviceIds);

  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const svc = services[id];
      if (!svc) return acc;

      // Skip conductor - autoheal will handle it
      if (id === conductorServiceName) {
        console.log(`   ⏭️  Skipping ${id} (conductor)`);
        return acc;
      }

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

      console.log(`\n   Service: ${id}`);
      console.log(`   Container name: ${containerName}`);
      console.log(`   Current volumes:`, svc.volumes);
      console.log(`   Normalized volumes:`, normalizedVolumes);

      // Remove old data/logs volumes and legacy target volumes
      const otherVolumes = (svc.volumes || []).filter(
        v =>
          !v.startsWith('./data/') &&
          !v.startsWith('./logs/') &&
          !v.includes('\\data\\') &&
          !v.includes('\\logs\\'),
      );

      console.log(`   Other volumes (non data/logs):`, otherVolumes);

      // Combine: keep other volumes + add normalized data/logs volumes
      const nextVolumes = [...otherVolumes, ...normalizedVolumes];

      console.log(`   Next volumes:`, nextVolumes);

      // Check if volumes actually changed
      const volumesChanged =
        svc.volumes?.length !== nextVolumes.length ||
        !svc.volumes?.every(v => nextVolumes.includes(v));

      if (!volumesChanged) {
        console.log(`   ✅ No change for ${id}`);
        return acc;
      }

      console.log(`   ❌ Marking ${id} as updated`);

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
