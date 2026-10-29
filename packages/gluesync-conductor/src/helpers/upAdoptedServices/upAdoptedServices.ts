import { getLogger } from '../../utils/logger';
import createActions from '../dockerode/createActions/createActions';
import ensureVolumeDirs from '../ensureVolumeDirs/ensureVolumeDirs';
import { StartUpdatedServicesArgs } from './UpAdoptedServices.model';

// Each service once, without the conductor (delicate, handled by autoHeal). autoAdoptServices reports a service once per
// change it made to it (env_file, network, port, stack mount...), and starting the same service twice in parallel runs two
// `docker compose up` that recreate the same container at once: the second fails on the name, and the old container is
// left running as "<id>_<project>-<service>-1", without the changes.
export const servicesToStart = (
  updatedIds: ReadonlyArray<string>,
  conductorServiceName: string,
): ReadonlyArray<string> =>
  [...new Set(updatedIds)].filter(id => id !== conductorServiceName);

const upAdoptedServices: StartUpdatedServicesArgs = async (
  docker,
  updatedIds,
) => {
  const logger = getLogger();
  const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';
  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

  if (updatedIds.length === 0) {
    logger.info('No updated services to start');
    return;
  }

  logger.info('Some adopted services needs to be restarted');

  const actions = createActions({
    docker,
    filename: dkrComposeFile,
  });

  const conductorServiceName =
    process.env.CONDUCTOR_NAME || 'gluesync-conductor';

  // Run all starts in parallel, each service once
  const promises = servicesToStart(updatedIds, conductorServiceName).map(id => {
    const ensureVolumesPromise = isWindows
      ? ensureVolumeDirs(id)
      : Promise.resolve();

    return ensureVolumesPromise
      .then(() => {
        logger.info(`Starting adopted service: ${id}`);
        return actions.start(id);
      })
      .then(() => {
        logger.info(`Service ${id} started`);
      })
      .catch(error => {
        logger.error({ error, service: id }, 'Failed to start adopted service');
      });
  });

  await Promise.all(promises);
};

export default upAdoptedServices;
