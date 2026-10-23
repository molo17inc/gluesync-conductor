import { readComposeFile } from '../../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../../composeFile/writeComposeFile/writeComposeFile';
import { getLogger } from '../../../utils/logger';
import getService from '../getService/getService';
import stripImageDigest from '../stripImageDigest/stripImageDigest';
import { ReconcileSelfImage } from './reconcileSelfImage.model';

const isNotFound = (error: unknown): boolean =>
  (error as { statusCode?: number })?.statusCode === 404;

/**
 * The self update writes the Conductor's new image to the stack file before
 * Swarm replaces its task. When Swarm rolls the new image back, the stack file
 * is left naming an image that does not run, and the next `docker stack
 * deploy` would redeploy it. The rolled back Conductor is the one starting
 * here, so it puts the image of its own service back in the stack file.
 * Never throws: a failed reconcile must not stop the startup.
 */
const reconcileSelfImage: ReconcileSelfImage = async (docker, orchestrator) => {
  const logger = getLogger();
  const { namespace, selfService } = orchestrator;
  const fullName = `${namespace}_${selfService}`;

  try {
    const service = await getService(docker, fullName);

    if (service.updateState !== 'rollback_completed') {
      return 'no-rollback';
    }

    const composeJson = await readComposeFile({ raw: true });
    const fileService = composeJson.services?.[selfService];
    const fileImage = fileService?.image;

    if (!fileService || !fileImage || !service.image) {
      return 'skipped';
    }

    // A `${TAG}` in the stack file is the customer's to manage, not ours to
    // overwrite with what it resolved to
    if (fileImage.includes('$')) {
      logger.warn(
        { service: selfService, image: fileImage },
        '[swarm] the Conductor rolled back but its stack file image uses a variable: not changed',
      );

      return 'skipped';
    }

    if (stripImageDigest(fileImage) === service.image) {
      return 'in-sync';
    }

    await writeComposeFile({
      ...composeJson,
      services: {
        ...composeJson.services,
        [selfService]: { ...fileService, image: service.image },
      },
    });

    logger.warn(
      { service: selfService, stackFileImage: fileImage, image: service.image },
      '[swarm] the Conductor update was rolled back: stack file image set back to the image the service runs',
    );

    return 'reconciled';
  } catch (error) {
    if (!isNotFound(error)) {
      logger.warn(
        { error, service: selfService },
        '[swarm] could not reconcile the Conductor image with the stack file',
      );
    }

    return 'skipped';
  }
};

export default reconcileSelfImage;
