import { existsSync } from 'fs';
import { join } from 'path';
import { AddEnvFile } from './AddEnvFileToServices.model';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;
const ROOT_FOLDER_PATH = isWindows
  ? 'C:\\opt\\gluesync-conductor\\root-folder'
  : '/opt/gluesync-conductor/root-folder';
const ENV_FILE = '.env';

/**
 * Helper to normalize env_file to array
 */
const normalizeEnvFile = (envFile: any): ReadonlyArray<string> => {
  if (!envFile) return [];
  if (Array.isArray(envFile)) return envFile;
  if (typeof envFile === 'string') return [envFile];
  return [];
};

/**
 * Add .env to services that don't have it (if .env file exists).
 * Only runs if root folder is mounted and .env file is present.
 * Returns updated services and IDs that changed.
 */
const addEnvFileToServices: AddEnvFile = (services, serviceIds) => {
  // First check if root folder is mounted
  const rootFolderExists = existsSync(ROOT_FOLDER_PATH);

  if (!rootFolderExists) {
    console.log(
      `📋 addEnvFileToServices: root folder not mounted at ${ROOT_FOLDER_PATH}, skipping`,
    );
    return { services: {}, updatedIds: [] };
  }

  // Check if .env file exists in root folder
  const envFilePath = join(ROOT_FOLDER_PATH, ENV_FILE);
  const envFileExists = existsSync(envFilePath);

  console.log(
    `📋 addEnvFileToServices: .env file ${envFileExists ? 'exists' : 'does not exist'} at ${envFilePath}`,
  );

  if (!envFileExists) {
    console.log('   ⏭️  Skipping - no .env file found');
    return { services: {}, updatedIds: [] };
  }

  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const service = services[id];
      if (!service) return acc;

      const currentEnvFile = normalizeEnvFile(service.env_file);
      const hasEnvFile = currentEnvFile.includes(ENV_FILE);

      if (hasEnvFile) {
        console.log(`   ✅ ${id} already has .env file`);
        return acc;
      }

      // Add .env to the beginning (lowest priority)
      const finalEnvFile = [ENV_FILE, ...currentEnvFile];

      console.log(`   ❌ Adding .env to ${id}`);

      return {
        updatedServices: {
          ...acc.updatedServices,
          [id]: { ...service, env_file: finalEnvFile },
        },
        updatedIds: [...acc.updatedIds, id],
      };
    },
    {
      updatedServices: {} as Record<string, any>,
      updatedIds: [] as ReadonlyArray<string>,
    },
  );

  return { services: updatedServices, updatedIds };
};

export default addEnvFileToServices;
