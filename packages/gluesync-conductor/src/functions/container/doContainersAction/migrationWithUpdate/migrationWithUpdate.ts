import { readComposeFile } from '../../../../helpers/composeFile/readComposeFile/readComposeFile';
import getRootPath from '../../../../helpers/getRootPath/getRootPath';
import restartLinux from '../../../../helpers/restartAllServices/linuxRestart';
import restartWindows from '../../../../helpers/restartAllServices/windowsRestart';
import runMigrationScript from '../../../../helpers/runMigrationScript/runMigrationScript';
import { getLogger } from '../../../../utils/logger';
import { MigrationWithUpdate } from './migrationWithUpdate.model';
import prepareComposeUpdate from '../prepareComposeUpdate/prepareComposeUpdate';
import { LabelPrefix } from '../../../../models/composeFile.model';
import { markMigrationCompleted } from '../../../../helpers/migrationNeeded/migrationNeeded';
import createActions from '../../../../helpers/dockerode/createActions/createActions';

const migrationWithUpdate: MigrationWithUpdate = async (
  requestIds,
  releaseChannel,
  isWindows,
  helperImageWindows,
  docker,
) => {
  const logger = getLogger();
  logger.info('[migration] Migration to v2 enabled — starting flow');

  const composeJson = await readComposeFile({ raw: true });

  const agentIds = Object.entries(composeJson.services ?? {})
    .filter(([, service]: any) =>
      Array.isArray(service.labels)
        ? service.labels.includes(`${LabelPrefix.CONDUCTOR}.type=agent`)
        : service.labels?.[`${LabelPrefix.CONDUCTOR}.type`] === 'agent',
    )
    .map(([id]) => id);

  // Assuming you have access to `req.server.docker` (or docker client)
  const actions = createActions({ docker });

  // Stop all agent services
  await Promise.allSettled(agentIds.map(id => actions.stop(id)));

  logger.info(
    { stoppedAgents: agentIds.length },
    '[migration] stopped all agent services before removal',
  );

  // Run migration script
  const scriptResult = await runMigrationScript();
  if (!scriptResult.success) {
    logger.error(
      { scriptResult },
      '[migration] script failed, aborting migration',
    );
    throw new Error(scriptResult.error || 'Migration script failed');
  }
  logger.info('[migration] Script execution completed');

  const cleanedComposeJson = {
    ...composeJson,
    services: Object.fromEntries(
      Object.entries(composeJson.services || {}).filter(
        ([id]) => !agentIds.includes(id),
      ),
    ),
  };

  logger.info(
    { removedAgents: agentIds.length },
    '[migration] removed all agent services from compose',
  );

  // Update compose images (without touching containers)
  await prepareComposeUpdate(cleanedComposeJson, requestIds, releaseChannel);
  logger.info('[migration] docker-compose updated');

  // Mark complete AFTER successful migration
  await markMigrationCompleted();

  // Restart full stack (DETACHED)
  setImmediate(() => {
    const hostProjectDir = getRootPath({ basePath: process.env.BASE_PATH });
    const restartFn = isWindows ? restartWindows : restartLinux;

    restartFn({
      hostProjectDir,
      helperImage: isWindows ? helperImageWindows : 'docker:28',
      log: msg => logger.info(`[migration-restart] ${msg}`),
    }).catch(err => {
      logger.error({ err }, '[migration] restart failed');
    });
  });
};

export default migrationWithUpdate;
