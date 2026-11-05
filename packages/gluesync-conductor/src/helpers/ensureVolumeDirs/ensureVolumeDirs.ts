import fs from 'fs';
import path from 'path';
import { LongVolume } from '../../models/composeFile.model';
import { getLogger } from '../../utils/logger';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import { KIT_DIR_IN_CONTAINER } from '../containerRuntime/composeEnv';
import getRootPath from '../getRootPath/getRootPath';
import { EnsureVolumeDirs } from './EnsureVolumeDirs.model';

const isWindows = (): boolean =>
  process.env.IS_WINDOWS?.toLowerCase() === 'true';

const makeDirs = (dirs: ReadonlyArray<string>): void => {
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

// Windows keeps its convention: every service gets a logs and a data folder
const ensureWindowsDirs = (id: string): void => {
  // Ensure all dirs are created under "<rootPath>/root-folder"
  const rootPath = path.join(getRootPath(), 'root-folder');

  makeDirs([path.join(rootPath, 'logs', id), path.join(rootPath, 'data', id)]);
};

const bindSource = (volume: unknown): string | undefined => {
  if (typeof volume === 'string') {
    return volume.split(':')[0].trim();
  }

  const long = volume as Partial<LongVolume> | null;

  return long?.type === 'bind' ? long.source : undefined;
};

// Only a folder the kit owns: `./logs/<id>`. A relative source with an
// extension or a leading dot is a file (a license, a logback.xml, `.env`) that
// has to exist already, not a folder to invent.
const relativeFolder = (source: string | undefined): string | undefined => {
  if (!source || source.includes('$') || !source.startsWith('./')) {
    return undefined;
  }

  const name = path.posix.basename(source);

  return name === '.' || name.startsWith('.') || path.posix.extname(name)
    ? undefined
    : source;
};

const foldersOf = async (
  id: string,
  rootFolder: string,
): Promise<ReadonlyArray<string>> => {
  const compose = await readComposeFile({ raw: true });
  const volumes: ReadonlyArray<unknown> = compose.services?.[id]?.volumes ?? [];

  return volumes
    .map(volume => relativeFolder(bindSource(volume)))
    .filter((source): source is string => source !== undefined)
    .map(source => path.join(rootFolder, source))
    .filter(folder => folder.startsWith(`${rootFolder}${path.sep}`));
};

/**
 * Creates the bind source folders of a service before `compose up`: Docker
 * creates a missing one itself (as root), Podman refuses to start the
 * container. They are made under the kit directory as this container sees it
 * (the host path of a relative bind is the same folder) and are never chowned.
 * On Linux this never throws: a folder that cannot be made is left to compose.
 */
const ensureVolumeDirs: EnsureVolumeDirs = async (
  id,
  { rootFolder = KIT_DIR_IN_CONTAINER } = {},
) => {
  if (isWindows()) {
    ensureWindowsDirs(id);
    return;
  }

  try {
    // Without the kit mounted (a dev run) there is no host folder to prepare
    if (fs.existsSync(rootFolder)) {
      makeDirs(await foldersOf(id, rootFolder));
    }
  } catch (error) {
    getLogger().warn(
      { error, service: id },
      '[ensure-volume-dirs] could not prepare the bind folders of the service',
    );
  }
};

export default ensureVolumeDirs;
