import fs from 'fs/promises';
import path from 'path';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import { LabelPrefix } from '../../models/composeFile.model';
import { getLogger } from '../../utils/logger';

const LINUX_ROOT = '/opt/gluesync-conductor/root-folder';
const WINDOWS_ROOT = 'C:\\opt\\gluesync-conductor\\root-folder';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

const ROOT_PATH = isWindows ? WINDOWS_ROOT : LINUX_ROOT;

const MIGRATION_FILE = path.join(ROOT_PATH, '.migration-to-v2.json');

const logger = getLogger();

export const markMigrationCompleted = async (): Promise<void> => {
  try {
    const payload = {
      completed: true,
      completedAt: new Date().toISOString(),
    };

    await fs.writeFile(
      MIGRATION_FILE,
      JSON.stringify(payload, null, 2),
      'utf-8',
    );
  } catch (error) {
    logger.error({ error }, '[migration-complete] Error:');
  }
};

export const migrationNeeded = async (): Promise<boolean> => {
  logger.debug('[migration-check] Starting migration check');
  logger.debug(
    { file: MIGRATION_FILE },
    '[migration-check] MIGRATION_FILE path:',
  );

  try {
    // Check migration file
    try {
      const file = await fs.readFile(MIGRATION_FILE, 'utf-8');
      logger.debug({ file }, '[migration-check] migration file contents');

      const parsed = JSON.parse(file);
      logger.debug({ parsed }, '[migration-check] parsed migration file');

      if (parsed?.completed === true) {
        logger.debug(
          '[migration-check] Migration already completed → skipping',
        );
        return false;
      }
    } catch (error) {
      logger.error(
        { error },
        '[migration-check] migration file does not exist or unreadable',
      );
    }

    logger.debug('[migration-check] Reading compose file...');
    const composeJson = await readComposeFile({ raw: true });

    logger.debug(
      { keys: Object.keys(composeJson?.services || {}) },
      '[migration-check] Compose services keys',
    );

    const hasAgents = Object.entries(composeJson.services ?? {}).some(
      ([, service]: any) =>
        Array.isArray(service.labels)
          ? service.labels.includes(`${LabelPrefix.CONDUCTOR}.type=agent`)
          : service.labels?.[`${LabelPrefix.CONDUCTOR}.type`] === 'agent',
    );

    logger.debug({ hasAgents }, '[migration-check] hasAgents');

    if (hasAgents) {
      logger.debug('[migration-check] Migration required → returning true');
      return true;
    }

    logger.debug(
      '[migration-check] No agents found → marking migration complete',
    );
    await markMigrationCompleted();

    return false;
  } catch (error) {
    console.error('[migration-check] Fatal error:', error);
    return false;
  }
};
