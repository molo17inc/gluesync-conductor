import { restartAll } from 'docker-compose';
import { getLogger } from '../../../utils/logger';
import getRootPath from '../../getRootPath/getRootPath';
import waitForContainerReady from '../../waitForContainerReady/waitForContainerReady';
import { enableUpdateMode } from '../../../plugins/apiBlockerAsUpdating';
import { autoReboot } from '../../autoReboot/autoReboot';
import { RestartWindowsDependentServices } from './restartWindowsDependentServices.models';

const helperImageWindows = process.env.HELPER_IMAGE_BASE || '';

/**
 * Special handling for core-hub on Windows only.
 * Windows NAT DNS cache requires dependent services to restart for reconnection.
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
    .catch(err => {
      logger.warn(
        { service: chronosService, error: err },
        `[core-hub-updater] failed to restart ${chronosService}`,
      );
      return 'restart failed';
    });

  // Prepare response message
  const restartSummary = `${chronosService} ${chronosRestartResult}, ${conductorService} restarting`;
  const responseMessage = `Core-hub ${coreHubServiceId} updated and restarted. Dependent services: ${restartSummary}.`;

  // Enable update mode to block incoming requests during conductor restart
  enableUpdateMode();

  logger.info(
    { service: conductorService },
    `[core-hub-updater] triggering ${conductorService} restart`,
  );

  // Wrap in setImmediate to send response before conductor dies
  setImmediate(() => {
    autoReboot({
      hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
      serviceName: conductorService,
      helperImage: helperImageWindows,
      log: msg =>
        logger.info({ msg }, '[core-hub-updater] conductor restart log'),
    }).catch(err => {
      logger.error({ error: err }, '[core-hub-updater] autoReboot failed');
    });
  });

  return responseMessage;
};

export default restartWindowsDependentServices;
