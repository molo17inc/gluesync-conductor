import { getLogger } from '../../../utils/logger';
import {
  composeFilePath,
  refreshLastGoodFrom,
} from '../composeBackup/composeBackup';
import ensureValidCompose from '../ensureValidCompose/ensureValidCompose';

/**
 * First thing at startup, before the heal steps read and rewrite the compose
 * file: an empty or corrupt one is restored from the last-good copy, and a
 * valid one becomes the last-good copy. Never throws, so a damaged compose
 * file does not keep the conductor from starting.
 */
export const guardComposeAtStartup = async (): Promise<void> => {
  try {
    const path = composeFilePath();
    if (await ensureValidCompose(path)) {
      await refreshLastGoodFrom(path);
    }
  } catch (error) {
    getLogger().error(
      { error },
      '[compose-guard] docker-compose.yml is unusable and could not be restored',
    );
  }
};

/** Runs one startup heal step; a failure (full disk, corrupt compose) is logged and the start goes on. */
export const runStartupStep = async <T>(
  name: string,
  step: () => Promise<T>,
  fallback: T,
): Promise<T> => {
  try {
    return await step();
  } catch (error) {
    getLogger().error({ error }, `[startup] ${name} failed, continuing`);
    return fallback;
  }
};
