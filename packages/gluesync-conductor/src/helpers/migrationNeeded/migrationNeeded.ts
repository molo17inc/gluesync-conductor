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
  } catch (err) {
    console.error('[migration-complete] Error:', err);
  }
};

export const migrationNeeded = async (): Promise<boolean> => {
  try {
    // If migration file exists and completed=true → no migration needed
    try {
      const file = await fs.readFile(MIGRATION_FILE, 'utf-8');
      const parsed = JSON.parse(file);

      if (parsed?.completed === true) {
        return false;
      }
    } catch {
      // file doesn't exist → continue
    }

    // Auto-detect agents in compose
    const composeJson = await readComposeFile({ raw: true });

    const hasAgents = Object.values(composeJson.services || {}).some(
      (svc: any) => {
        const labels = svc.labels || {};
        return labels[`${LabelPrefix.CONDUCTOR}.type`] === 'agent';
      },
    );

    if (hasAgents) {
      return true;
    }

    // No agents → mark completed
    await markMigrationCompleted();
    return false;
  } catch (err) {
    console.error('[migration-check] Error:', err);
    return false;
  }
};
