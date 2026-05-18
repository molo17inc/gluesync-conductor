import { existsSync } from 'node:fs';
import { join } from 'path';

import { AddEnvFile } from './AddEnvFileToServices.model';
import buildEnvFileConf from '../buildEnvFileConf/buildEnvFileConf';
import { EnvFileElement } from '../../models/composeFile.model';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

const ROOT_FOLDER_PATH = isWindows
  ? 'C:\\opt\\gluesync-conductor\\root-folder'
  : '/opt/gluesync-conductor/root-folder';

const ENV_FILE_NAME = '.env';

const normalizeEnvFileEntry = (
  envFileEntry: Readonly<EnvFileElement>,
): { path: string; required: boolean } | null => {
  if (typeof envFileEntry === 'string') {
    const path = envFileEntry.trim();
    if (!path) {
      return null;
    }
    return { path, required: true };
  }

  const path = (envFileEntry.path ?? '').trim();
  if (!path) {
    return null;
  }

  return { path, required: envFileEntry.required ?? true };
};

const hasBothRequiredEnvFiles = (envFile: unknown): boolean => {
  if (!Array.isArray(envFile)) {
    return false;
  }

  const rootEnvPath = join(ROOT_FOLDER_PATH, ENV_FILE_NAME);

  const state = (envFile as ReadonlyArray<EnvFileElement>).reduce(
    (acc, entry) => {
      const normalized = normalizeEnvFileEntry(entry);
      if (!normalized) {
        return acc;
      }

      const hasLocal =
        acc.hasLocal ||
        (normalized.path === '.env' && normalized.required === false);

      const hasRoot =
        acc.hasRoot ||
        (normalized.path === rootEnvPath && normalized.required === false);

      return { hasLocal, hasRoot };
    },
    { hasLocal: false, hasRoot: false },
  );

  return state.hasLocal && state.hasRoot;
};

// simple deep clone to avoid shared references -> avoids YAML anchors in most writers
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * Add env_file to the specified services.
 * Only adds it if missing the required two entries (does NOT overwrite).
 *
 * Only applies if the conductor root-folder mount exists.
 */
const addEnvFileToServices: AddEnvFile = (services, serviceIds) => {
  const rootFolderMounted = existsSync(ROOT_FOLDER_PATH);

  if (!rootFolderMounted) {
    console.log(
      `addEnvFileToServices: root-folder not mounted at ${ROOT_FOLDER_PATH}, skipping env_file`,
    );
    return { services: {}, updatedIds: [] };
  }

  const result = serviceIds.reduce(
    (acc, id) => {
      const service = services[id];
      if (!service) {
        return acc;
      }

      const currentEnvFile = (service as { env_file?: unknown }).env_file;

      // already has both required entries -> do nothing
      if (hasBothRequiredEnvFiles(currentEnvFile)) {
        return acc;
      }

      const envFile = clone(buildEnvFileConf());

      console.log(
        `addEnvFileToServices: adding env_file for ${id}: ${ENV_FILE_NAME} + ${join(
          ROOT_FOLDER_PATH,
          ENV_FILE_NAME,
        )}`,
      );

      return {
        updatedServices: {
          ...acc.updatedServices,
          [id]: { ...service, env_file: envFile },
        },
        updatedIds: [...acc.updatedIds, id],
      };
    },
    { updatedServices: {} as Record<string, any>, updatedIds: [] as string[] },
  );

  return { services: result.updatedServices, updatedIds: result.updatedIds };
};

export default addEnvFileToServices;
