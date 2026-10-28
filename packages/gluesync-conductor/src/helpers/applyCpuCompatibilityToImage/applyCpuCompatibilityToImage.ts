import { RawComposeService } from '../../models/composeFile.model';
import detectCpuSupportsX8664V3 from '../detectCpuSupportsX86_64V3/detectCpuSupportsX86_64V3';
import dockerImageExists from '../dockerImageExists/dockerImageExists';
import parseImage from '../parseImage/parseImage';

export type ApplyCpuCompatibilityResult = {
  services: Readonly<Record<string, RawComposeService>>;
  updatedIds: ReadonlyArray<string>;
};

export type ImageExists = (image: string) => Promise<boolean>;

export type ApplyCpuCompatibilityToImage = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
  isWindows: boolean,
  imageExists?: ImageExists,
) => Promise<ApplyCpuCompatibilityResult>;

const DEBIAN_SUFFIX = '-debian';

const stripDebianSuffix = (image: string): string => {
  const parts = image.split(':');
  return parts.length === 2
    ? `${parts[0]}:${parts[1].replace(/-debian$/, '')}`
    : `${image.replace(/-debian$/, '')}`;
};

const addDebianSuffix = (image: string): string => {
  const parts = image.split(':');
  return parts.length === 2
    ? `${parts[0]}:${parts[1]}${DEBIAN_SUFFIX}`
    : `${image}${DEBIAN_SUFFIX}`;
};

/**
 * Core Hub: the `-debian` variant has always existed, so it is applied (or
 * removed on a v3 CPU) without asking anyone.
 */
const coreHubImage = (image: string, cpuSupportsV3: boolean): string => {
  const hasDebianSuffix = image.includes(DEBIAN_SUFFIX);

  if (!cpuSupportsV3) {
    return hasDebianSuffix ? image : addDebianSuffix(image);
  }

  return hasDebianSuffix ? stripDebianSuffix(image) : image;
};

/**
 * Chronos has `-debian` tags only from 0.3.2 on (beta 0.1.68, alpha 0.0.325),
 * so on an old CPU the suffix is added only when that image exists.
 * - untagged is `latest`
 * - a digest pin or a Compose-interpolated tag is the customer's: left alone
 */
const chronosImage = async (
  image: string,
  cpuSupportsV3: boolean,
  imageExists: ImageExists,
): Promise<string> => {
  const { fullName, tag, digest, interpolatedTag } = parseImage(image);

  if (digest || interpolatedTag) {
    return image;
  }

  const hasDebianSuffix = tag.endsWith(DEBIAN_SUFFIX);

  if (cpuSupportsV3) {
    return hasDebianSuffix
      ? `${fullName}:${tag.slice(0, -DEBIAN_SUFFIX.length)}`
      : image;
  }

  if (hasDebianSuffix) {
    return image;
  }

  const candidate = `${fullName}:${tag || 'latest'}${DEBIAN_SUFFIX}`;

  if (await imageExists(candidate)) {
    return candidate;
  }

  console.log(
    `[CPU] ${candidate} does not exist, keeping ${image} (no -debian variant for this Chronos version).`,
  );
  return image;
};

/**
 * Image of a Core Hub or Chronos service for this host's CPU. Any other image
 * comes back untouched.
 */
export const cpuCompatibleImage = async (
  image: string,
  cpuSupportsV3: boolean,
  imageExists: ImageExists = dockerImageExists,
): Promise<string> => {
  const { imageName } = parseImage(image);

  if (imageName === 'gluesync-core-hub') {
    return coreHubImage(image, cpuSupportsV3);
  }

  if (imageName === 'gluesync-chronos') {
    return chronosImage(image, cpuSupportsV3, imageExists);
  }

  return image;
};

/**
 * Image a Chronos service must have after an update to `image` (already on
 * the new version): `-debian` on an old Linux CPU when that image exists,
 * else as is. It only ever adds the suffix: an image that already has it
 * keeps it, and no other service is touched.
 */
export const cpuCompatibleChronosUpdateImage = async (
  image: string,
  isWindows: boolean,
  imageExists: ImageExists = dockerImageExists,
): Promise<string> => {
  const { imageName, tag } = parseImage(image);

  if (
    isWindows ||
    imageName !== 'gluesync-chronos' ||
    tag.endsWith(DEBIAN_SUFFIX)
  ) {
    return image;
  }

  const cpuSupportsV3 = detectCpuSupportsX8664V3();

  return cpuSupportsV3
    ? image
    : chronosImage(image, cpuSupportsV3, imageExists);
};

/**
 * Applies CPU compatibility suffix (-debian) to core-hub and chronos images
 * ONLY when running on Linux AND CPU does NOT support x86-64-v3 (and removes
 * it on a CPU that does). Chronos gets it only when the `-debian` image
 * exists (see `chronosImage`).
 *
 * Mirrors the style of addGluesyncHostToAgents and other service mutators.
 */
const applyCpuCompatibilityToImage: ApplyCpuCompatibilityToImage = async (
  services,
  serviceIds,
  isWindows,
  imageExists = dockerImageExists,
) => {
  if (isWindows) {
    return { services, updatedIds: [] };
  }

  const cpuSupportsV3 = detectCpuSupportsX8664V3();

  const changes = await Promise.all(
    serviceIds.map(async id => {
      const service = services[id];
      if (!service) {
        return null;
      }

      const nextImage = await cpuCompatibleImage(
        service.image,
        cpuSupportsV3,
        imageExists,
      );

      return nextImage === service.image
        ? null
        : ([id, { ...service, image: nextImage }] as const);
    }),
  );

  const updated = changes.filter(
    (change): change is NonNullable<typeof change> => change !== null,
  );

  return updated.length === 0
    ? { services, updatedIds: [] }
    : {
        services: { ...services, ...Object.fromEntries(updated) },
        updatedIds: updated.map(([id]) => id),
      };
};

export default applyCpuCompatibilityToImage;
