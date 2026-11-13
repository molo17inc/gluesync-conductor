import { restartAll } from 'docker-compose';
import { getLogger } from '../../../utils/logger';
import waitForContainerReady from '../../waitForContainerReady/waitForContainerReady';
import { RestartWindowsDependentServices } from './restartWindowsDependentServices.models';

/**
 * Special handling for core-hub on Windows only.
 * Windows NAT DNS cache requires dependent services to restart for reconnection.
 * Chronos restarts here; the Conductor itself restarts once the update has
 * replied (see conductorRestartAfterUpdate): restarting it now would cut the
 * update short, its rollback and the reply included.
 */
const restartWindowsDependentServices: RestartWindowsDependentServices = async (
  docker,
  runCmd,
  filename,
  coreHubServiceId,
  chronosService,
  conductorService,
) => {
  const logger = getLogger();

  logger.info(
    { service: coreHubServiceId },
    '[core-hub-updater] updating core-hub (Windows) and restarting dependent services',
  );

  // Wait for core-hub to be fully ready
  try {
    await waitForContainerReady(docker, coreHubServiceId, 10, 1000);
    logger.info(
      { service: coreHubServiceId },
      '[core-hub-updater] core-hub is ready',
    );
  } catch (error) {
    logger.warn(
      { service: coreHubServiceId, error },
      '[core-hub-updater] core-hub readiness check failed, proceeding anyway',
    );
  }

  // Restart chronos and capture result
  const chronosRestartResult = await runCmd(
    restartAll,
    chronosService,
    filename,
    ['--no-deps'],
  )
    .then(() => {
      logger.info(
        { service: chronosService },
        `[core-hub-updater] restarted ${chronosService} to reconnect to updated core-hub`,
      );
      return 'restarted';
    })
    .catch(error => {
      logger.warn(
        { service: chronosService, error },
        `[core-hub-updater] failed to restart ${chronosService}`,
      );
      return 'restart failed';
    });

  const restartSummary = `${chronosService} ${chronosRestartResult}, ${conductorService} restarts after this reply`;
  const responseMessage = `Core-hub ${coreHubServiceId} updated and restarted. Dependent services: ${restartSummary}.`;

  return responseMessage;
};

export default restartWindowsDependentServices;
