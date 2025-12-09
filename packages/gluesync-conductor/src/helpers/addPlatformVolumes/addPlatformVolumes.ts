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

  console.log('📦 addPlatformVolumes called');
  console.log('   isWindows:', isWindows);
  console.log('   serviceIds:', serviceIds);

  // Helper to normalize volume for comparison (strip mount options like :ro, :rw)
  const stripMountOptions = (vol: string): string => {
    return vol.replace(/:r[ow]$/, '');
  };

  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const svc = services[id];
      if (!svc) return acc;

      // Skip core-hub and conductor - autoheal will handle them
      if (id === coreHubName || id === conductorName) {
        console.log(`   ⏭️  Skipping ${id} (core-hub or conductor)`);
        return acc;
      }

      // Check if service is an agent (has conductor.type=agent label)
      const isAgent = Array.isArray(svc.labels)
        ? svc.labels.some(l => l.includes('com.molo17.conductor.type=agent'))
        : Object.entries(svc.labels || {}).some(
            ([k, v]) => k === 'com.molo17.conductor.type' && v === 'agent',
          );

      // ✅ Only normalize agents - skip modules (they have custom paths)
      if (!isAgent) {
        console.log(`   ⏭️  Skipping ${id} (not an agent)`);
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

      console.log(`\n   Service: ${id} (agent)`);
      console.log(`   Container name: ${containerName}`);
      console.log(`   Current volumes:`, svc.volumes);
      console.log(`   Normalized volumes:`, normalizedVolumes);

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

      console.log(`   Other volumes (non data/logs/shared):`, otherVolumes);

      // Combine: other volumes + all normalized volumes
      const nextVolumes = [...otherVolumes, ...normalizedVolumes];

      console.log(`   Next volumes:`, nextVolumes);

      // Compare semantically (ignore :ro differences during comparison)
      const currentNormalized = (svc.volumes || [])
        .map(stripMountOptions)
        .sort();
      const nextNormalized = nextVolumes.map(stripMountOptions).sort();

      const volumesChanged =
        currentNormalized.length !== nextNormalized.length ||
        !currentNormalized.every((v, i) => v === nextNormalized[i]);

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
