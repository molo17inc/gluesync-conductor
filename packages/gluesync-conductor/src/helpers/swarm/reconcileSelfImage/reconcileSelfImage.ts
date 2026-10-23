import { readComposeFile } from '../../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../../composeFile/writeComposeFile/writeComposeFile';
import { getLogger } from '../../../utils/logger';
import { inspectSelf } from '../../orchestrator/getOrchestrator/getOrchestrator';
import getService from '../getService/getService';
import stripImageDigest from '../stripImageDigest/stripImageDigest';
import { ReconcileSelfImage } from './reconcileSelfImage.model';

const isNotFound = (error: unknown): boolean =>
  (error as { statusCode?: number })?.statusCode === 404;

const ROLLBACK_STATES = new Set([
  'rollback_started',
  'rollback_paused',
  'rollback_completed',
]);

// What this process runs, from its own container: Swarm marks the rollback
// completed only after its monitor window, so the spec of the service can
// still name the image that was rolled back when this task starts
const inspectRunningImage = async (
  docker: Parameters<ReconcileSelfImage>[0],
): Promise<string | undefined> => {
  try {
    const image = (await inspectSelf(docker))?.Config?.Image;

    return image ? stripImageDigest(image) : undefined;
  } catch (error) {
    getLogger().warn(
      { error },
      '[swarm] could not inspect the Conductor container: using the image of its service',
    );

    return undefined;
  }
};

/**
 * The self update writes the Conductor's new image to the stack file before
 * Swarm replaces its task. When Swarm rolls the new image back, the stack file
 * is left naming an image that does not run, and the next `docker stack
 * deploy` would redeploy it. The rolled back Conductor is the one starting
 * here, so it puts the image it runs back in the stack file as soon as it
 * starts, whatever stage the rollback is at. Never throws: a failed reconcile
 * must not stop the startup.
 */
const reconcileSelfImage: ReconcileSelfImage = async (docker, orchestrator) => {
  const logger = getLogger();
  const { namespace, selfService } = orchestrator;
  const fullName = `${namespace}_${selfService}`;

  try {
    const service = await getService(docker, fullName);

    if (!service.updateState || !ROLLBACK_STATES.has(service.updateState)) {
      return 'no-rollback';
    }

    const runningImage = (await inspectRunningImage(docker)) ?? service.image;

    const composeJson = await readComposeFile({ raw: true });
    const fileService = composeJson.services?.[selfService];
    const fileImage = fileService?.image;

    if (!fileService || !fileImage || !runningImage) {
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

    if (stripImageDigest(fileImage) === runningImage) {
      return 'in-sync';
    }

    await writeComposeFile({
      ...composeJson,
      services: {
        ...composeJson.services,
        [selfService]: { ...fileService, image: runningImage },
      },
    });

    logger.warn(
      { service: selfService, stackFileImage: fileImage, image: runningImage },
      '[swarm] the Conductor update was rolled back: stack file image set back to the image the Conductor runs',
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
