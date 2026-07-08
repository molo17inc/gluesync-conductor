import { RawComposeService } from '../../models/composeFile.model';
import detectCpuSupportsX8664V3 from '../detectCpuSupportsX86_64V3/detectCpuSupportsX86_64V3';
import parseImage from '../parseImage/parseImage';

export type ApplyCpuCompatibilityResult = {
  services: Readonly<Record<string, RawComposeService>>;
  updatedIds: ReadonlyArray<string>;
};

export type ApplyCpuCompatibilityToImage = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
  isWindows: boolean,
) => ApplyCpuCompatibilityResult;

/**
 * Applies CPU compatibility suffix (-debian) to core-hub and chronos images
 * ONLY when running on Linux AND CPU does NOT support x86-64-v3.
 *
 * Mirrors the style of addGluesyncHostToAgents and other service mutators.
 */
const applyCpuCompatibilityToImage: ApplyCpuCompatibilityToImage = (
  services,
  serviceIds,
  isWindows,
) => {
  if (isWindows) {
    return { services, updatedIds: [] };
  }

  const cpuSupportsV3 = detectCpuSupportsX8664V3();
  if (cpuSupportsV3) {
    return { services, updatedIds: [] };
  }

  const result = serviceIds.reduce(
    (acc, id) => {
      const service = services[id];
      if (!service) {
        return acc;
      }

      const { imageName } = parseImage(service.image);

      // Only core-hub and chronos need compatibility suffix
      if (
        imageName !== 'gluesync-core-hub' &&
        imageName !== 'gluesync-chronos'
      ) {
        return acc;
      }

      // Avoid double suffix
      if (service.image.includes('-debian')) {
        return acc;
      }

      const nextImage = (() => {
        const parts = service.image.split(':');
        return parts.length === 2
          ? `${parts[0]}:${parts[1]}-debian`
          : `${service.image}-debian`;
      })();

      return {
        updatedServices: {
          ...acc.updatedServices,
          [id]: { ...service, image: nextImage },
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
      result.updatedIds.length === 0
        ? services
        : { ...services, ...result.updatedServices },
    updatedIds: result.updatedIds,
  };
};

export default applyCpuCompatibilityToImage;
