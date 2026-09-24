import { createHash } from 'node:crypto';
import { access, chmod, copyFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { getLogger } from '../../utils/logger';
import { SyncCollectLogsScriptsResult } from './syncCollectLogsScripts.model';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

const ROOT_FOLDER_PATH = isWindows
  ? String.raw`C:\opt\gluesync-conductor\root-folder`
  : '/opt/gluesync-conductor/root-folder';

const logger = getLogger();

const fileSha256 = async (path: string): Promise<string | null> => {
  try {
    const content = await readFile(path);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
};

const syncCollectLogsScripts =
  async (): Promise<SyncCollectLogsScriptsResult> => {
    try {
      const scriptName = isWindows ? 'collect-logs.ps1' : 'collect-logs.sh';

      const sourceCandidates = [
        join(process.cwd(), scriptName),
        join(process.cwd(), 'build', scriptName),
      ];

      const checks = sourceCandidates.map(candidate =>
        access(candidate, constants.F_OK)
          .then(() => candidate)
          .catch(() => null),
      );

      const sourcePath =
        (await Promise.all(checks)).find(result => result !== null) ?? null;

      if (!sourcePath) {
        logger.warn(
          { sourceCandidates },
          '[collect-logs-sync] bundled script not found, skipping sync',
        );
        return { success: false, synced: false };
      }

      const targetPath = join(ROOT_FOLDER_PATH, scriptName);

      const [sourceHash, targetHash] = await Promise.all([
        fileSha256(sourcePath),
        fileSha256(targetPath),
      ]);

      if (sourceHash && targetHash && sourceHash === targetHash) {
        logger.info('[collect-logs-sync] nothing to sync');
        return { success: true, synced: false };
      }

      await copyFile(sourcePath, targetPath);

      if (!isWindows) {
        await chmod(targetPath, 0o755);
      }

      logger.info(
        { sourcePath, targetPath },
        '[collect-logs-sync] script synced to root folder',
      );

      return { success: true, synced: true };
    } catch (error) {
      logger.error({ error }, '[collect-logs-sync] failed to sync script');
      return { success: false, synced: false };
    }
  };

export default syncCollectLogsScripts;
