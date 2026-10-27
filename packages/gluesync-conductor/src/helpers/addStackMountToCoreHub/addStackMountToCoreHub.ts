import { LongVolume, RawComposeService } from '../../models/composeFile.model';
import { AddStackMountToCoreHub } from './addStackMountToCoreHub.model';

// The platform's whole data folder, mounted in Core Hub next to its own data: Core Hub's backup takes Chronos' jobs
// (data/chronos/scheduler.db) from it, and a restore puts them back there. Core Hub's own mount is left as it is.
const STACK_SOURCE = './data';
export const STACK_TARGET_LINUX = '/opt/gluesync/stack';
export const STACK_TARGET_WINDOWS = String.raw`C:\opt\gluesync\stack`;

// The container side of a short-syntax volume, without the :ro/:rw mode: the last part that holds no ':' but its own drive
// letter. Windows sources and targets both start with one ("D:\Gluesync\data:C:\opt\..."), so the string cannot simply be
// split on ':'.
const targetOf = (volume: string | LongVolume): string | undefined => {
  if (typeof volume !== 'string') {
    return volume.target;
  }
  const withoutMode = volume.replace(/:(ro|rw)$/i, '');
  const match = /:((?:[A-Za-z]:)?[\\/][^:]*)$/.exec(withoutMode);
  return match?.[1];
};

const sameTarget = (a: string, b: string, isWindows: boolean): boolean => {
  const normalize = (p: string) => p.replace(/[\\/]+$/, '');
  return isWindows
    ? normalize(a).replaceAll('/', '\\').toLowerCase() ===
        normalize(b).toLowerCase()
    : normalize(a) === normalize(b);
};

const addStackMountToCoreHub: AddStackMountToCoreHub = (
  services,
  serviceIds,
  isWindows,
) => {
  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
  const target = isWindows ? STACK_TARGET_WINDOWS : STACK_TARGET_LINUX;

  const svc = services[coreHubName];
  if (!svc || !serviceIds.includes(coreHubName)) {
    return { services, updatedIds: [] };
  }

  const volumes = (svc.volumes ?? []) as ReadonlyArray<string | LongVolume>;
  const alreadyMounted = volumes.some(volume => {
    const current = targetOf(volume);
    return current !== undefined && sameTarget(current, target, isWindows);
  });
  if (alreadyMounted) {
    return { services, updatedIds: [] };
  }

  const nextService: RawComposeService = {
    ...svc,
    volumes: [...volumes, `${STACK_SOURCE}:${target}`],
  };
  console.log(
    `[addStackMountToCoreHub] Mounting ${STACK_SOURCE} at ${target} in ${coreHubName}`,
  );

  return {
    services: { ...services, [coreHubName]: nextService },
    updatedIds: [coreHubName],
  };
};

export default addStackMountToCoreHub;
