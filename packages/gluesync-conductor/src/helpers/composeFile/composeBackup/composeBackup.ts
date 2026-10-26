import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import getRootPath from '../../getRootPath/getRootPath';
import safeWriteFile from '../../file/safeWriteFile/safeWriteFile';
import { getLogger } from '../../../utils/logger';
import inspectCompose from '../inspectCompose/inspectCompose';
import { RefreshLastGood } from './composeBackup.model';

const LAST_GOOD_FILE = 'docker-compose.last-good.yml';
const BACKUP_FOLDER = '.conductor';

const isWindows = (): boolean =>
  process.env.IS_WINDOWS?.toLowerCase() === 'true';

// The kit mounts its folder here; the data folder is the fallback home.
const mountedFolders = (): ReadonlyArray<string> =>
  isWindows()
    ? [
        String.raw`C:\opt\gluesync-conductor\root-folder`,
        String.raw`C:\opt\gluesync\data`,
      ]
    : ['/opt/gluesync-conductor/root-folder', '/opt/gluesync/data'];

export const composeFilePath = (filename?: string): string =>
  getRootPath({
    filename:
      filename ?? (process.env.DKR_COMPOSE_FILE || 'docker-compose.yml'),
  });

// The backup is of the compose file the conductor manages, not of any other YAML.
export const isMainComposeFile = (path: string): boolean =>
  resolve(path) === resolve(composeFilePath());

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const findMountedFolder = async (): Promise<string | undefined> =>
  (
    await Promise.all(
      mountedFolders().map(async folder =>
        (await isDirectory(folder)) ? folder : undefined,
      ),
    )
  ).find(folder => folder !== undefined);

/**
 * Where the last-good copy lives. In the root-folder mount it is on the host
 * next to the kit, so it survives container recreation and is reachable when
 * the compose file itself is gone.
 */
export const getBackupDir = async (): Promise<string> => {
  const override = process.env.CONDUCTOR_COMPOSE_BACKUP_DIR?.trim();
  if (override) {
    return override;
  }
  const folder = await findMountedFolder();
  return join(folder ?? dirname(composeFilePath()), BACKUP_FOLDER);
};

export const getLastGoodPath = async (): Promise<string> =>
  join(await getBackupDir(), LAST_GOOD_FILE);

const assertValidCompose = (content: Buffer): void => {
  const { problem } = inspectCompose(content.toString('utf8'));
  if (problem) {
    throw new Error(`not a usable compose file: ${problem}`);
  }
};

const readIfExists = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

/** The last-good compose text, or null when there is none or it is not valid. */
export const readLastGood = async (): Promise<string | null> => {
  try {
    const text = await readIfExists(await getLastGoodPath());
    return text !== null && inspectCompose(text).problem === null ? text : null;
  } catch (error) {
    getLogger().warn({ error }, '[compose-backup] cannot read last-good');
    return null;
  }
};

/** Replaces the last-good copy with `content`, which must be a valid compose file. */
export const refreshLastGood: RefreshLastGood = async content => {
  const target = await getLastGoodPath();
  if ((await readIfExists(target)) === content.toString()) {
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await safeWriteFile(target, content, {
    validate: assertValidCompose,
    mode: 'replace',
  });
};

/**
 * Refreshes the last-good copy from the compose file on disk. A failure is
 * logged, never thrown: the backup must not fail the write it follows.
 */
export const refreshLastGoodFrom = async (path: string): Promise<void> => {
  try {
    await refreshLastGood(await readFile(path));
  } catch (error) {
    getLogger().warn(
      { error },
      '[compose-backup] could not refresh the last-good compose backup',
    );
  }
};
