import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import compareImageTags from '../imageTagOrder/imageTagOrder';
import parseImage from '../parseImage/parseImage';
import { observeService } from '../serviceContainers/serviceContainers';
import { getLogger } from '../../utils/logger';
import { LabelPrefix, RawComposeService } from '../../models/composeFile.model';
import { PinnedImage, PinRunningImages } from './pinRunningImages.model';

const CORE_HUB_LABEL = `${LabelPrefix.CONDUCTOR}.type=core-hub`;

const isCoreHub = (service: Readonly<RawComposeService>): boolean => {
  const labels = Array.isArray(service.labels)
    ? service.labels
    : Object.entries(service.labels || {}).map(([k, v]) => `${k}=${v}`);

  return labels.includes(CORE_HUB_LABEL);
};

// The service when its container runs another tag of the same image than the
// compose file names. A container that exists but has stopped counts too: its
// data (CoreHub's database above all) was already migrated by that image.
const findPin = async (
  docker: Parameters<PinRunningImages>[0],
  id: string,
  service: Readonly<RawComposeService>,
): Promise<PinnedImage | undefined> => {
  if (typeof service.image !== 'string') {
    return undefined;
  }

  const declared = parseImage(service.image);

  // `image: x:${TAG:-2.3.0}` is the customer's to change, and only Compose
  // knows its value; a digest pins the image whatever the tag says
  if (declared.interpolatedTag || declared.digest) {
    return undefined;
  }

  const { image } = await observeService(docker, id);
  const running = parseImage(image ?? '');

  // A different image altogether, or one known only by its id, is not drift
  if (
    !image ||
    !running.tag ||
    running.fullName !== declared.fullName ||
    running.digest
  ) {
    return undefined;
  }

  if (declared.tag === running.tag) {
    return undefined;
  }

  return {
    service: id,
    coreHub: isCoreHub(service),
    composeImage: service.image,
    runningImage: `${declared.fullName}:${running.tag}`,
    composeIs: compareImageTags(declared.tag, running.tag),
  };
};

/**
 * Before a full stack restart, which recreates every service from the compose
 * file: a restart brings back the versions that run, it never changes them.
 * A service whose compose file names another tag than its container runs gets
 * the running tag written into the compose file (and so into its last-good
 * copy). Returns what was changed.
 *
 * An older compose tag is the dangerous one: it comes from an update made
 * outside the conductor (Portainer, `docker`), and CoreHub cannot go back. Its
 * database was migrated forward and has no way down, so it exits on every
 * start (2026-11-07, HQ: compose 2.3.1.3, running 2.3.1.4). A newer one is an
 * update that did not finish: it is for the update to apply, not a restart.
 */
const pinRunningImages: PinRunningImages = async docker => {
  const composeJson = await readComposeFile({ raw: true });
  const services = Object.entries(composeJson.services ?? {});

  const pins = (
    await Promise.all(
      services.map(([id, service]) => findPin(docker, id, service)),
    )
  ).filter((pin): pin is PinnedImage => pin !== undefined);

  if (pins.length === 0) {
    return pins;
  }

  const pinned = Object.fromEntries(
    pins.map(pin => [pin.service, pin.runningImage]),
  );

  await writeComposeFile({
    ...composeJson,
    services: Object.fromEntries(
      services.map(([id, service]) => [
        id,
        pinned[id] ? { ...service, image: pinned[id] } : service,
      ]),
    ),
  });

  pins.forEach(pin => {
    getLogger().warn(
      { ...pin, reason: 'compose-differs-from-running' },
      '[conductor-restart] compose file named another image tag than the running container: pinned the running tag before restarting',
    );
  });

  return pins;
};

export default pinRunningImages;
