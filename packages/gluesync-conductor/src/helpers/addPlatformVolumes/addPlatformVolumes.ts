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
  console.log('📦 addPlatformVolumes called');
  console.log('   isWindows:', isWindows);
  console.log('   serviceIds:', serviceIds);

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

      console.log(`\n   Service: ${id}`);
      console.log(`   Container name: ${containerName}`);
      console.log(`   Current volumes:`, svc.volumes);
      console.log(`   Normalized volumes:`, normalizedVolumes);

      const filteredExisting = (svc.volumes || []).filter(
        v => !v.startsWith('./data/target') && !v.startsWith('./logs/target'),
      );

      console.log(`   Filtered existing:`, filteredExisting);

      // Only add normalized volumes that don't already exist
      const volumesToAdd = normalizedVolumes.filter(
        nv => !filteredExisting.includes(nv),
      );

      console.log(`   Volumes to add:`, volumesToAdd);

      const nextVolumes = [...filteredExisting, ...volumesToAdd];

      console.log(`   Next volumes:`, nextVolumes);

      // Check if anything actually changed
      if (
        volumesToAdd.length === 0 &&
        filteredExisting.length === (svc.volumes?.length || 0)
      ) {
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
