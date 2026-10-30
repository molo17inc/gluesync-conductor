import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Docker from 'dockerode';

import getRootPath from '../getRootPath/getRootPath';
import parseEnvFile from '../swarm/parseEnvFile/parseEnvFile';
import {
  ENGINE_SOCKET_IN_CONTAINER,
  resolveHostSocketPath,
} from './hostSocketPath';

export const SOCKET_VARIABLE = 'GS_CONTAINER_SOCKET';

// The kit directory as this container sees it (the kit mounts `./` there)
export const KIT_DIR_IN_CONTAINER = '/opt/gluesync-conductor/root-folder';

const isWindows = (): boolean =>
  process.env.IS_WINDOWS?.toLowerCase() === 'true';

/**
 * The kit's project `.env`, as a path this container can read. `BASE_PATH`
 * (the `--project-directory` of compose) is a HOST path that usually does not
 * exist in here, so compose never finds the `.env` next to it by itself.
 * Undefined when there is none (a dev run, a Windows container).
 */
export const kitEnvFilePath = (): string | undefined =>
  isWindows()
    ? undefined
    : [
        join(KIT_DIR_IN_CONTAINER, '.env'),
        join(getRootPath() || '.', '.env'),
      ].find(existsSync);

export const readKitEnv = (): Readonly<Record<string, string>> => {
  const file = kitEnvFilePath();

  if (!file) {
    return {};
  }

  try {
    return parseEnvFile(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

/**
 * `--env-file` for the compose commands the Conductor runs, so the variables of
 * the kit `.env` (GS_CONTAINER_SOCKET, GS_COREHUB_USERNS, ...) reach the
 * interpolation of the compose file.
 */
export const composeEnvFileOptions = (): ReadonlyArray<string> => {
  const file = kitEnvFilePath();

  return file ? ['--env-file', file] : [];
};

/**
 * GS_CONTAINER_SOCKET for a compose run that has none: the socket this
 * container itself runs on, so recreating a socket-mounting service (the
 * Conductor, the proxy) keeps the same mount instead of falling back to
 * `/var/run/docker.sock`. Nothing is added when `existing` already has it, or
 * when the socket is the Docker default (which is what compose falls back to).
 */
export const missingSocketVariable = async (
  docker: Readonly<Docker>,
  existing: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<Record<string, string>>> => {
  if (existing[SOCKET_VARIABLE]?.trim()) {
    return {};
  }

  const socket = await resolveHostSocketPath(docker);

  return socket === ENGINE_SOCKET_IN_CONTAINER
    ? {}
    : { [SOCKET_VARIABLE]: socket };
};

/**
 * What to add to the environment of the compose child: GS_CONTAINER_SOCKET,
 * unless the process environment or the kit `.env` says it.
 */
export const composeChildEnv = async (
  docker: Readonly<Docker>,
): Promise<NodeJS.ProcessEnv | undefined> => {
  const extra = isWindows()
    ? {}
    : await missingSocketVariable(docker, {
        ...readKitEnv(),
        ...process.env,
      });

  return Object.keys(extra).length > 0
    ? { ...process.env, ...extra }
    : undefined;
};

/**
 * `-e` options that give a helper container the socket path, when its own
 * project `.env` (read from the mounted kit directory) does not have one.
 */
export const helperSocketEnvArgs = async (
  docker: Readonly<Docker>,
): Promise<ReadonlyArray<string>> =>
  Object.entries(await missingSocketVariable(docker, readKitEnv())).flatMap(
    ([key, value]) => ['-e', `${key}=${value}`],
  );
