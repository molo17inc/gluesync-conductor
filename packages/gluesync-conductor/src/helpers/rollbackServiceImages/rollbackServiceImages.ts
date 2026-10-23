import { upAll } from 'docker-compose';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import { runCmd } from '../dockerode/createActions/createActions';
import describeFailure from '../describeFailure/describeFailure';
import { getLogger } from '../../utils/logger';
import {
  RollbackOutcome,
  RollbackServiceImages,
} from './rollbackServiceImages.model';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

type Rollbacks = Parameters<RollbackServiceImages>[0];

// A failure here (full disk, unreadable compose) must not replace the error
// that made the update fail: it is logged and reported next to it instead.
const putImagesBack = async (
  rollbacks: Rollbacks,
): Promise<string | undefined> => {
  try {
    const compose = await readComposeFile({ raw: true });
    const services = Object.fromEntries(
      Object.entries(compose.services ?? {}).map(([id, service]) => {
        const rollback = rollbacks.find(r => r.id === id);
        return [id, rollback ? { ...service, image: rollback.image } : service];
      }),
    );
    await writeComposeFile({ ...compose, services });
    return undefined;
  } catch (error) {
    const message = describeFailure(error);
    getLogger().error(
      { error: message, services: rollbacks.map(r => r.id) },
      '[update] could not put the previous images back in the compose file',
    );
    return `compose file could not be restored: ${message}`;
  }
};

/**
 * Puts services back on the image they had before a failed update. The compose
 * file is rewritten before images are pulled, so without this a failed pull
 * left it pointing at an image that does not exist (and the next restart of
 * that service failed). With `recreate`, the container is brought back on the
 * old image too (for a new image that does not stay up).
 */
const rollbackServiceImages: RollbackServiceImages = async (
  rollbacks,
  { recreate },
) => {
  const logger = getLogger();
  if (rollbacks.length === 0) {
    return [];
  }

  const failure = await putImagesBack(rollbacks);
  if (failure) {
    // Recreating now would only start the new image again.
    return rollbacks.map(({ id, image }) => ({
      id,
      image,
      ok: false,
      error: failure,
    }));
  }

  return rollbacks.reduce<Promise<RollbackOutcome[]>>(
    async (previous, { id, image }) => {
      const done = await previous;
      if (!recreate) {
        return [...done, { id, image, ok: true }];
      }
      try {
        await runCmd(upAll, id, dkrComposeFile, ['--no-deps']);
        logger.warn({ service: id, image }, '[update] rolled back service');
        return [...done, { id, image, ok: true }];
      } catch (error) {
        const message = describeFailure(error);
        logger.error(
          { service: id, image, error: message },
          '[update] rollback failed',
        );
        return [...done, { id, image, ok: false, error: message }];
      }
    },
    Promise.resolve([]),
  );
};

export default rollbackServiceImages;
