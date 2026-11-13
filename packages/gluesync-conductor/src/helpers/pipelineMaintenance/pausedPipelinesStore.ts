import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getBackupDir } from '../composeFile/composeBackup/composeBackup';
import safeWriteFile from '../file/safeWriteFile/safeWriteFile';
import { getLogger } from '../../utils/logger';
import {
  PausedPipelinesRecord,
  PausedPipelinesStore,
} from './pipelineMaintenance.model';

export const PAUSED_PIPELINES_FILE = 'update-paused-pipelines.json';

const codeOf = (error: unknown): string | undefined =>
  (error as { code?: string } | null)?.code;

const asRecord = (raw: unknown): PausedPipelinesRecord | null => {
  const r = raw as Readonly<Record<string, unknown>> | null;
  if (!r || !Array.isArray(r.pipelineIds)) {
    return null;
  }
  return {
    pausedAt: typeof r.pausedAt === 'string' ? r.pausedAt : '',
    pipelineIds: r.pipelineIds.filter(
      (id): id is string => typeof id === 'string' && id !== '',
    ),
  };
};

/**
 * The pipelines an update put in maintenance mode, kept in the Conductor's
 * folder next to the compose/stack file (`.conductor/`, the same folder as its
 * last-good copy) so that a Conductor restarted in the middle of an update
 * still resumes them.
 */
const createPausedPipelinesStore = (
  pathOf: () => Promise<string> = async () =>
    join(await getBackupDir(), PAUSED_PIPELINES_FILE),
): PausedPipelinesStore => ({
  read: async () => {
    const path = await pathOf();
    try {
      return asRecord(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') {
        getLogger().warn(
          { path, error },
          '[pipeline-maintenance] paused pipelines file unreadable, ignored',
        );
      }
      return null;
    }
  },
  write: async record => {
    const path = await pathOf();
    await mkdir(dirname(path), { recursive: true });
    await safeWriteFile(path, `${JSON.stringify(record, null, 2)}\n`);
  },
  clear: async () => {
    const path = await pathOf();
    try {
      await unlink(path);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') {
        throw error;
      }
    }
  },
});

export default createPausedPipelinesStore;
