import { LabelPrefix } from '../../models/composeFile.model';
import { AddPlatformVolumes } from './AddPlatformVolumes.model';

/**
 * Ensure agent services have required platform volumes.
 * - Preserves existing volumes (short syntax strings)
 * - Adds missing shared/logs/data mounts (platform-specific)
 * - Returns ONLY changed services
 *
 * Compose short syntax: [SOURCE:]TARGET[:MODE]. [web:19]
 */
const addPlatformVolumes: AddPlatformVolumes = (
  services,
  serviceIds,
  isWindows,
) => {
  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
  const conductorName = process.env.CONDUCTOR_NAME || 'gluesync-conductor';

  const parseVolumeTarget = (vol: string): string | null => {
    const s = vol.trim();
    if (!s) return null;

    // No ":" => anonymous volume with TARGET only
    if (!s.includes(':')) return s;

    // Right-biased parsing to support Windows "C:\..." in SOURCE
    const parts = s.split(':');
    const last = parts[parts.length - 1];
    const isMode = last === 'ro' || last === 'rw';

    return isMode ? parts[parts.length - 2] : parts[parts.length - 1];
  };

  const toStringVolumes = (vols: unknown): string[] => {
    if (!Array.isArray(vols)) return [];
    // You said you'll always have short syntax like "./x:/y[:ro]"
    // so enforce strings and ignore anything else defensively.
    return vols.filter((v): v is string => typeof v === 'string');
  };

  const hasTarget = (volumes: ReadonlyArray<string>, target: string): boolean =>
    volumes.some(v => parseVolumeTarget(v) === target);

  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const svc = services[id];
      if (!svc) return acc;

      if (id === coreHubName || id === conductorName) return acc;

      const isAgent = Array.isArray(svc.labels)
        ? svc.labels.some(l =>
            l.includes(`${LabelPrefix.CONDUCTOR}.type=agent`),
          )
        : Object.entries(svc.labels || {}).some(
            ([k, v]) => k === `${LabelPrefix.CONDUCTOR}.type` && v === 'agent',
          );

      if (!isAgent) return acc;

      const required = isWindows
        ? {
            sharedTarget: `C:\\opt\\gluesync\\shared`,
            logsTarget: `C:\\opt\\gluesync\\logs`,
            dataTarget: `C:\\opt\\gluesync\\data`,
            shared: `./shared:C:\\opt\\gluesync\\shared:ro`,
            logs: `./logs/${id}:C:\\opt\\gluesync\\logs`,
            data: `./data/${id}:C:\\opt\\gluesync\\data`,
          }
        : {
            sharedTarget: `/opt/gluesync/shared`,
            logsTarget: `/opt/gluesync/logs`,
            dataTarget: `/opt/gluesync/data`,
            shared: `./shared:/opt/gluesync/shared:ro`,
            logs: `./logs/${id}:/opt/gluesync/logs`,
            data: `./data/${id}:/opt/gluesync/data`,
          };

      const currentVolumes = toStringVolumes(svc.volumes);

      const additions = [
        ...(!hasTarget(currentVolumes, required.sharedTarget)
          ? [required.shared]
          : []),
        ...(!hasTarget(currentVolumes, required.logsTarget)
          ? [required.logs]
          : []),
        ...(!hasTarget(currentVolumes, required.dataTarget)
          ? [required.data]
          : []),
      ];

      if (additions.length === 0) return acc;

      return {
        updatedServices: {
          ...acc.updatedServices,
          [id]: {
            ...svc,
            // Ensure we write back short-syntax string[] only
            volumes: [...currentVolumes, ...additions],
          },
        },
        updatedIds: [...acc.updatedIds, id],
      };
    },
    {
      updatedServices: {} as Record<string, any>,
      updatedIds: [] as ReadonlyArray<string>,
    },
  );

  return { services: updatedServices, updatedIds };
};

export default addPlatformVolumes;
