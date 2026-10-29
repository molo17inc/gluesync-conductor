import { readFile } from 'node:fs/promises';
import safeWriteFile from '../../file/safeWriteFile/safeWriteFile';
import { getLogger } from '../../../utils/logger';
import {
  isMainComposeFile,
  readLastGood,
} from '../composeBackup/composeBackup';
import inspectCompose from '../inspectCompose/inspectCompose';
import { ComposeFileCorruptError } from './composeFile.errors';
import { EnsureValidCompose } from './ensureValidCompose.model';

const readIfExists = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const restoreFromLastGood = async (
  path: string,
  problem: string,
): Promise<Record<string, any>> => {
  const lastGood = await readLastGood();
  const restored = lastGood === null ? null : inspectCompose(lastGood).value;
  if (lastGood === null || !restored || !isMainComposeFile(path)) {
    throw new ComposeFileCorruptError(path, problem);
  }
  await safeWriteFile(path, lastGood);
  getLogger().error(
    { path, problem },
    '[compose-guard] restored docker-compose.yml from last-good backup',
  );
  return restored;
};

/**
 * Returns the parsed compose file, undefined when it does not exist. A file
 * that is empty or unusable (a full disk leaves exactly that) is put back from
 * the last-good copy, or reported with ComposeFileCorruptError: reading it as
 * `{}` made every read-modify-write caller save a stub compose over it.
 */
const ensureValidCompose: EnsureValidCompose = async path => {
  const text = await readIfExists(path);
  if (text === undefined) {
    return undefined;
  }
  const { problem, value } = inspectCompose(text);
  return problem === null && value
    ? value
    : restoreFromLastGood(path, problem ?? 'unreadable');
};

export default ensureValidCompose;
