import { copyFile, rm, stat } from 'fs/promises';
import { isDeepStrictEqual } from 'util';

import writeYmlFile from '../../file/writeYmlFile/writeYmlFile';
import getRootPath from '../../getRootPath/getRootPath';
import { readComposeFile } from '../readComposeFile/readComposeFile';
import { WriteComposeFile } from './writeComposeFile.model';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

const writeComposeFile: WriteComposeFile = async (
  json,
  filename = dkrComposeFile,
) => {
  const targetPath = getRootPath({ filename });
  const backupPath = `${targetPath}.bak`;
  const isMainCompose = filename === dkrComposeFile;

  if (isMainCompose) {
    try {
      await stat(targetPath);
      await copyFile(targetPath, backupPath);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        await rm(backupPath, { force: true });
      } else {
        throw error;
      }
    }
  }

  try {
    await writeYmlFile(json, filename);

    if (isMainCompose) {
      const reRead = await readComposeFile({ filename, raw: true });
      if (!isDeepStrictEqual(reRead, json)) {
        throw new Error(
          'Verification failed: written compose file does not match intended data',
        );
      }
    }
  } catch (error) {
    if (isMainCompose) {
      try {
        await stat(backupPath);
        await copyFile(backupPath, targetPath);
      } catch {
        // No backup available to restore; the original error will still be thrown.
      }
    }
    throw error;
  }
};

export default writeComposeFile;
