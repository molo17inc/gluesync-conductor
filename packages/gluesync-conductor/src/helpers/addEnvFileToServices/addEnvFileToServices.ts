import { existsSync } from 'fs';
import { join } from 'path';
import { AddEnvFile } from './AddEnvFileToServices.model';
import buildEnvFileConf from '../buildEnvFileConf/buildEnvFileConf';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

const ROOT_FOLDER_PATH = isWindows
  ? 'C:\\opt\\gluesync-conductor\\root-folder'
  : '/opt/gluesync-conductor/root-folder';

const ENV_FILE_NAME = '.env';

type EnvFileEntry =
  | string
  | Readonly<{
      path?: string;
      required?: boolean;
    }>;

const normalizeEnvFileEntry = (
  e: EnvFileEntry,
): { path: string; required: boolean } | null => {
  if (typeof e === 'string') {
    const p = e.trim();
    return p ? { path: p, required: true } : null;
  }
  const p = (e.path ?? '').trim();
  if (!p) return null;
  return { path: p, required: e.required ?? true };
};

const hasBothRequiredEnvFiles = (envFile: unknown): boolean => {
  if (!Array.isArray(envFile)) return false;

  const entries = (envFile as ReadonlyArray<EnvFileEntry>)
    .map(normalizeEnvFileEntry)
    .filter((x): x is { path: string; required: boolean } => x !== null);

  const rootEnvPath = join(ROOT_FOLDER_PATH, ENV_FILE_NAME);

  const hasLocal = entries.some(e => e.path === '.env' && e.required === false);
  const hasRoot = entries.some(
    e => e.path === rootEnvPath && e.required === false,
  );

  return hasLocal && hasRoot;
};

// simple deep clone to avoid shared references -> avoids YAML anchors in most writers [web:151]
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
      if (!service) return acc;

      // TODO remove when chronos is fixed: Skip env_file injection for Chronos on Windows
      if (isWindows && id === 'gluesync-chronos') {
        console.log(
          `addEnvFileToServices: skipping env_file for ${id} on Windows`,
        );
        return acc;
      }

      const currentEnvFile = (service as { env_file?: unknown }).env_file;

      // ✅ already has both required entries -> do nothing
      if (hasBothRequiredEnvFiles(currentEnvFile)) {
        return acc;
      }

      const envFile = clone(buildEnvFileConf());

      console.log(
        `📋 addEnvFileToServices: adding env_file for ${id}: ${ENV_FILE_NAME} + ${join(
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
