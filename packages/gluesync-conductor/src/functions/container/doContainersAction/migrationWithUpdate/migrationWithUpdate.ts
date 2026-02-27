import { readComposeFile } from '../../../../helpers/composeFile/readComposeFile/readComposeFile';
import getRootPath from '../../../../helpers/getRootPath/getRootPath';
import restartLinux from '../../../../helpers/restartAllServices/linuxRestart';
import restartWindows from '../../../../helpers/restartAllServices/windowsRestart';
import runMigrationScript from '../../../../helpers/runMigrationScript/runMigrationScript';
import { enableUpdateMode } from '../../../../plugins/apiBlockerAsUpdating';
import { getLogger } from '../../../../utils/logger';
import { MigrationWithUpdate } from './migrationWithUpdate.model';
import prepareComposeUpdate from './prepareComposeUpdate';
import { LabelPrefix } from '../../../../models/composeFile.model';
import { markMigrationCompleted } from '../../../../helpers/migrationNeeded/migrationNeeded';

const migrationWithUpdate: MigrationWithUpdate = async (
  requestIds,
  releaseChannel,
  isWindows,
  helperImageWindows,
) => {
  const logger = getLogger();
  logger.info('[migration] Migration to v2 enabled — starting flow');

  enableUpdateMode();

  const composeJson = await readComposeFile({ raw: true });

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

  // Remove all agent services from the compose file
  const cleanedComposeJson: typeof composeJson = {
    ...composeJson,
    services: Object.fromEntries(
      Object.entries(composeJson.services || {}).filter(([id, svc]) => {
        const labels = svc.labels as
          | string[]
          | Record<string, string>
          | undefined;
        const serviceType = Array.isArray(labels)
          ? labels
              .find(l => l.startsWith(`${LabelPrefix.CONDUCTOR}.type=`))
              ?.split('=')[1]
          : labels?.[`${LabelPrefix.CONDUCTOR}.type`];
        if (serviceType === 'agent') {
          logger.debug({ id }, 'Removing agent service');
        }
        return serviceType !== 'agent';
      }),
    ),
  };

  logger.info(
    {
      removedAgents:
        Object.keys(composeJson.services || {}).length -
        Object.keys(cleanedComposeJson.services || {}).length,
    },
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
