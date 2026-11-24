import { RawComposeService } from '../../../models/composeFile.model';
import { getLogger } from '../../../utils/logger';
import { findPin } from '../../pinRunningImages/pinRunningImages';
import { PinnedImage } from '../../pinRunningImages/pinRunningImages.model';
import parseImage from '../../parseImage/parseImage';
import { readComposeFile } from '../readComposeFile/readComposeFile';
import writeComposeFile from '../writeComposeFile/writeComposeFile';
import { ReconcileRunningImages } from './reconcileRunningImages.model';

const OWN_REPOSITORY_PREFIX = 'molo17/';
const CONDUCTOR_SERVICE = process.env.CONDUCTOR_NAME || 'gluesync-conductor';

// `2.3.2.1-debian` -> `debian`: a variant only follows the same variant
const variantOf = (tag: string): string => tag.split('-').slice(1).join('-');

// The Conductor's own image is the self-update's to change, never a heal's
const isConductor = (
  id: string,
  service: Readonly<RawComposeService>,
): boolean =>
  id === CONDUCTOR_SERVICE ||
  (typeof service.image === 'string' &&
    parseImage(service.image).repository.endsWith('gluesync-conductor'));

// Only the clear case: our own image, the compose tag a lower version than the
// running one (compareImageTags says `older` only when both are versions),
// the same variant. Anything else is left alone: when unsure, do nothing.
const isStale = (pin: Readonly<PinnedImage>): boolean => {
  const declared = parseImage(pin.composeImage);
  const running = parseImage(pin.runningImage);

  return (
    pin.composeIs === 'older' &&
    declared.repository.startsWith(OWN_REPOSITORY_PREFIX) &&
    variantOf(declared.tag) === variantOf(running.tag)
  );
};

/**
 * The compose file can name an older tag than the container runs (an update
 * made outside the Conductor, or one whose compose write was lost). Every
 * recreate driven by the compose file (adoption, the startup heals, an update's
 * rollback) would then downgrade the service, and Core Hub's databases only
 * migrate forward: it crash-loops with "A migration from 54 to 53 was required
 * but not found" (GS-1485). This writes the higher running tag into the compose
 * file (and so its last-good copy) first. It never lowers a tag, never touches
 * a service without a container nor the Conductor's own service.
 *
 * Run it where the compose file is already exclusively ours (the action gate).
 */
const reconcileRunningImages: ReconcileRunningImages = async docker => {
  const composeJson = await readComposeFile({ raw: true });
  const services = Object.entries(composeJson.services ?? {});

  // One service after the other: a Windows named pipe fails the connects made
  // all at once
  const found = await services.reduce(
    async (previous, [id, service]) => [
      ...(await previous),
      isConductor(id, service) ? undefined : await findPin(docker, id, service),
    ],
    Promise.resolve([] as ReadonlyArray<PinnedImage | undefined>),
  );

  const stale = found.filter(
    (pin): pin is PinnedImage => pin !== undefined && isStale(pin),
  );

  if (stale.length === 0) {
    return stale;
  }

  const running = Object.fromEntries(
    stale.map(pin => [pin.service, pin.runningImage]),
  );

  await writeComposeFile({
    ...composeJson,
    services: Object.fromEntries(
      services.map(([id, service]) => [
        id,
        running[id] ? { ...service, image: running[id] } : service,
      ]),
    ),
  });

  stale.forEach(pin => {
    getLogger().warn(
      `[compose-reconcile] ${pin.service} compose said ${pin.composeImage}, running ${pin.runningImage}: compose updated`,
    );
  });

  return stale;
};

export default reconcileRunningImages;
