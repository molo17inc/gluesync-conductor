import { readComposeFile } from '../../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../../composeFile/writeComposeFile/writeComposeFile';
import getRootPath from '../../getRootPath/getRootPath';
import removeKey from '../../removeKey/removeKey';
import { RawComposeFile } from '../../../models/composeFile.model';
import { getLogger } from '../../../utils/logger';
import forceUpdateService from '../forceUpdateService/forceUpdateService';
import getService from '../getService/getService';
import removeService from '../removeService/removeService';
import rollbackService from '../rollbackService/rollbackService';
import scaleService from '../scaleService/scaleService';
import stackDeploy from '../stackDeploy/stackDeploy';
import stripImageDigest from '../stripImageDigest/stripImageDigest';
import updateServiceImage from '../updateServiceImage/updateServiceImage';
import waitForServiceConverged from '../waitForServiceConverged/waitForServiceConverged';
import waitForServiceStopped from '../waitForServiceStopped/waitForServiceStopped';
import { ConvergeResult } from '../waitForServiceConverged/waitForServiceConverged.model';
import {
  CreateSwarmActions,
  SwarmContainerActions,
} from './createSwarmActions.model';

// The kit mounts the root folder here (docs/swarm-mode.md), `docker stack
// deploy` does not read the .env that sits in it
const STACK_ENV_FILE = '/opt/gluesync-conductor/root-folder/.env';

const isNotFound = (error: unknown): boolean =>
  (error as { statusCode?: number })?.statusCode === 404;

const failIfNot = (result: ConvergeResult): void => {
  if (!result.ok) {
    throw new Error(result.reason);
  }
};

/**
 * Container actions on a Docker Swarm stack (docs/swarm-mode.md). A Conductor
 * service id is the swarm service `<namespace>_<id>`.
 */
const createSwarmActions: CreateSwarmActions = ({
  docker,
  orchestrator,
  filename,
}) => {
  const { namespace, selfService } = orchestrator;
  const logger = getLogger();
  const fullName = (id: string): string => `${namespace}_${id}`;
  const isSelf = (id: string): boolean => id === selfService;

  const serviceExists = async (name: string): Promise<boolean> => {
    try {
      await getService(docker, name);

      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }

      throw error;
    }
  };

  const desiredReplicas = async (id: string): Promise<number> =>
    (await readComposeFile({ raw: true })).services?.[id]?.deploy?.replicas ??
    1;

  const imageInStackFile = async (id: string): Promise<string> => {
    const image = (await readComposeFile({ raw: true })).services?.[id]?.image;

    if (!image) {
      throw new Error(`Service ${id} has no image in the stack file`);
    }

    return image;
  };

  // The Conductor cannot wait for the replacement of its own task: the reply
  // goes out first, then the service is changed
  const afterReply = (what: string, change: () => Promise<unknown>): void => {
    setImmediate(() => {
      change().catch(error => {
        logger.error({ error }, `[swarm] ${what} of the conductor failed`);
      });
    });
  };

  const forceUpdateAndWait = async (id: string): Promise<void> => {
    await forceUpdateService(docker, fullName(id));
    failIfNot(await waitForServiceConverged(docker, fullName(id)));
  };

  // Swarm rolls a failed update back by itself (FailureAction=rollback), and
  // after that its "previous" spec is the bad one: rolling back again would
  // put the bad version back. Only a stalled or timed out update needs it.
  const rollBackFailedUpdate = async (
    id: string,
    previousImage: string,
  ): Promise<string> => {
    try {
      const { updateState } = await getService(docker, fullName(id));

      if (updateState?.startsWith('rollback')) {
        return `Swarm rolled the service back to ${previousImage}.`;
      }

      await rollbackService(docker, fullName(id));

      return `Rolled the service back to ${previousImage}.`;
    } catch (error) {
      logger.error({ error, service: id }, '[swarm] rollback failed');

      return `Rollback to ${previousImage} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  // Swarm rolls out any change of the spec, so a service that is already on
  // the image of the stack file must not be written at all (what `compose up`
  // does for an unchanged service)
  const alreadyOn = async (id: string, image: string): Promise<boolean> =>
    (await getService(docker, fullName(id))).image === stripImageDigest(image);

  const updateOtherService = async (id: string): Promise<string> => {
    const image = await imageInStackFile(id);

    if (await alreadyOn(id, image)) {
      return `Service ${id} is already on ${image}.`;
    }

    const before = await updateServiceImage(docker, fullName(id), image);
    const converged = await waitForServiceConverged(docker, fullName(id));

    if (!converged.ok) {
      throw new Error(
        `${converged.reason}. ${await rollBackFailedUpdate(id, before.image)}`,
      );
    }

    return `Agent ${id} updated and restarted.`;
  };

  const restartService = async (id: string, label: string): Promise<string> => {
    if (isSelf(id)) {
      afterReply(label, () => forceUpdateService(docker, fullName(id)));

      return `Conductor ${id} restart initiated.`;
    }

    await forceUpdateAndWait(id);

    return `Service ${id} restarted.`;
  };

  const actions: SwarmContainerActions = {
    start: async id => {
      if (await serviceExists(fullName(id))) {
        await scaleService(docker, fullName(id), await desiredReplicas(id));
      } else {
        // First start of a service that was only written to the stack file
        await stackDeploy(namespace, getRootPath({ filename }), STACK_ENV_FILE);
      }

      failIfNot(await waitForServiceConverged(docker, fullName(id)));

      return `Service ${id} started.`;
    },
    stop: async id => {
      await scaleService(docker, fullName(id), 0);
      failIfNot(await waitForServiceStopped(docker, fullName(id)));

      return `Service ${id} stopped.`;
    },
    restart: id => restartService(id, 'restart'),
    kill: id => restartService(id, 'kill'),
    pull: id =>
      Promise.resolve(
        `Swarm pulls the image of ${id} when the service updates.`,
      ),
    remove: async id => {
      await removeService(docker, fullName(id));

      return `Service ${id} removed.`;
    },
    undeploy: async id => {
      try {
        await removeService(docker, fullName(id));
      } catch (error) {
        // Never started: only the stack file has it
        if (!isNotFound(error)) {
          throw error;
        }
      }

      const composeJson = await readComposeFile({ raw: true });

      if (!composeJson.services?.[id]) {
        return `Agent ${id} not found`;
      }

      const composeFile: RawComposeFile = {
        ...composeJson,
        services: removeKey(composeJson.services, id),
      };

      await writeComposeFile(composeFile);

      return `Agent ${id} undeployed successfully`;
    },
    update: async id => {
      if (!isSelf(id)) {
        return updateOtherService(id);
      }

      const image = await imageInStackFile(id);

      if (await alreadyOn(id, image)) {
        return `Service ${id} is already on ${image}.`;
      }

      logger.info(
        { service: id, image },
        '[conductor-updater] running self update for conductor',
      );

      // Swarm replaces the task and goes back to the previous image on its own
      // if the new one fails: there is nothing left for this process to watch
      afterReply('self update', () =>
        updateServiceImage(docker, fullName(id), image),
      );

      return `Conductor ${id} updated and restarted.`;
    },
  };

  return actions;
};

export default createSwarmActions;
