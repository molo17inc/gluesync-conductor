import { getLogger } from '../../utils/logger';
import createActions from '../dockerode/createActions/createActions';
import ensureVolumeDirs from '../ensureVolumeDirs/ensureVolumeDirs';
import { StartUpdatedServicesArgs } from './UpAdoptedServices.model';

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

  // Run all starts in parallel, but skip conductor cause it's delica and handled by autoHeal
  const promises = updatedIds
    .filter(id => id !== conductorServiceName)
    .map(id => {
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
        .catch(err => {
          logger.error({ err, service: id }, 'Failed to start adopted service');
        });
    });

  await Promise.all(promises);
};

export default upAdoptedServices;
