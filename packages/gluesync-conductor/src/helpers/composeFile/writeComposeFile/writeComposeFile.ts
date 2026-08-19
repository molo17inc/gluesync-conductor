import { copyFile, mkdir, rename, rm, stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { isDeepStrictEqual } from 'util';

import writeYmlFile from '../../file/writeYmlFile/writeYmlFile';
import getRootPath from '../../getRootPath/getRootPath';
import { readComposeFile } from '../readComposeFile/readComposeFile';
import { WriteComposeFile } from './writeComposeFile.model';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

const maxRetries = 5;
const backoffBaseMs = 200;
const maxDelayMs = 5000;
const jitter = () => Math.floor(Math.random() * 100);

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const writeComposeFile: WriteComposeFile = async (
  json,
  filename = dkrComposeFile,
) => {
  const targetPath = getRootPath({ filename });
  const targetName = basename(filename);
  const backupName = `${targetName}.bak`;
  const newName = `${targetName}.new`;
  const basePath = dirname(targetPath);
  const backupPath = join(basePath, backupName);
  const newPath = join(basePath, newName);
  const isMainCompose = filename === dkrComposeFile;

  await mkdir(basePath, { recursive: true });

  if (!isMainCompose) {
    await writeYmlFile(json, filename);
    return;
  }

  const targetExisted = await (async (): Promise<boolean> => {
    try {
      await stat(targetPath);
      await copyFile(targetPath, backupPath);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return false;
      }
      throw error;
    }
  })();

  const attemptWrite = async (attempt: number): Promise<void> => {
    if (attempt > 1) {
      const waitMs = Math.min(
        maxDelayMs,
        backoffBaseMs * 2 ** (attempt - 1) + jitter(),
      );
      await delay(waitMs);
    }

    try {
      await writeYmlFile(json, newPath);

      const reRead = await readComposeFile({
        filename: newPath,
        raw: true,
      });

      if (!isDeepStrictEqual(reRead, json)) {
        throw new Error(
          'Verification failed: written compose file does not match intended data',
        );
      }

      try {
        await rename(newPath, targetPath);
      } catch (renameError) {
        if (
          renameError instanceof Error &&
          'code' in renameError &&
          renameError.code === 'EEXIST'
        ) {
          await copyFile(newPath, targetPath);
          try {
            await rm(newPath, { force: true });
          } catch {
            // Ignore cleanup failure; live file is already updated.
          }
        } else {
          throw renameError;
        }
      }
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      await attemptWrite(attempt + 1);
    }
  };

  try {
    await attemptWrite(1);
  } catch (error) {
    try {
      await rm(newPath, { force: true });
    } catch {
      // Ignore cleanup failure.
    }

    if (targetExisted) {
      try {
        await stat(backupPath);
        await copyFile(backupPath, targetPath);
      } catch {
        // No backup available to restore.
      }
    }

    throw error;
  }
};

export default writeComposeFile;
