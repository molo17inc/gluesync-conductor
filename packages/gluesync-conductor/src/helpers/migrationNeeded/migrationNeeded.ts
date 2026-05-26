import fs from 'fs/promises';
import path from 'path';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import { LabelPrefix } from '../../models/composeFile.model';

const LINUX_ROOT = '/opt/gluesync-conductor/root-folder';
const WINDOWS_ROOT = 'C:\\opt\\gluesync-conductor\\root-folder';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

const ROOT_PATH = isWindows ? WINDOWS_ROOT : LINUX_ROOT;

const MIGRATION_FILE = path.join(ROOT_PATH, '.migration-to-v2.json');

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
    console.error('[migration-complete] Error:', error);
  }
};

export const migrationNeeded = async (): Promise<boolean> => {
  console.log('[migration-check] Starting migration check');
  console.log('[migration-check] MIGRATION_FILE path:', MIGRATION_FILE);

  try {
    // Check migration file
    try {
      const file = await fs.readFile(MIGRATION_FILE, 'utf-8');
      console.log('[migration-check] migration file contents:', file);

      const parsed = JSON.parse(file);
      console.log('[migration-check] parsed migration file:', parsed);

      if (parsed?.completed === true) {
        console.log('[migration-check] Migration already completed → skipping');
        return false;
      }
    } catch (error) {
      console.log(
        '[migration-check] migration file does not exist or unreadable:',
        error,
      );
    }

    console.log('[migration-check] Reading compose file...');
    const composeJson = await readComposeFile({ raw: true });

    console.log(
      '[migration-check] Compose services keys:',
      Object.keys(composeJson?.services || {}),
    );

    const hasAgents = Object.entries(composeJson.services ?? {}).some(
      ([, service]: any) =>
        Array.isArray(service.labels)
          ? service.labels.includes(`${LabelPrefix.CONDUCTOR}.type=agent`)
          : service.labels?.[`${LabelPrefix.CONDUCTOR}.type`] === 'agent',
    );

    console.log('[migration-check] hasAgents =', hasAgents);

    if (hasAgents) {
      console.log('[migration-check] Migration required → returning true');
      return true;
    }

    console.log(
      '[migration-check] No agents found → marking migration complete',
    );
    await markMigrationCompleted();

    return false;
  } catch (error) {
    console.error('[migration-check] Fatal error:', error);
    return false;
  }
};
