import { copyFile, stat } from 'fs/promises';
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
  const backupFilename = `${filename}.bak`;
  const backupPath = getRootPath({ filename: backupFilename });
  const isMainCompose = filename === dkrComposeFile;

  if (!isMainCompose) {
    await writeYmlFile(json, filename);
    return;
  }

  const attemptWrite = async (attempt: number): Promise<void> => {
    if (attempt > 1) {
      const waitMs = Math.min(
        maxDelayMs,
        backoffBaseMs * 2 ** (attempt - 1) + jitter(),
      );
      await delay(waitMs);
    }

    try {
      try {
        await stat(targetPath);
        await copyFile(targetPath, backupPath);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          // Live file does not exist; nothing to back up.
        } else {
          throw error;
        }
      }

      await writeYmlFile(json, backupFilename);

      const reRead = await readComposeFile({
        filename: backupFilename,
        raw: true,
      });

      if (!isDeepStrictEqual(reRead, json)) {
        throw new Error(
          'Verification failed: written compose file does not match intended data',
        );
      }

      await copyFile(backupPath, targetPath);
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      await attemptWrite(attempt + 1);
    }
  };

  await attemptWrite(1);
};

export default writeComposeFile;
