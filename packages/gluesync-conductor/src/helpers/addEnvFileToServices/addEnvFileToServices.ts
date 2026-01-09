import { existsSync } from 'fs';
import { join } from 'path';
import { AddEnvFile } from './AddEnvFileToServices.model';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;
const ROOT_FOLDER_PATH = isWindows
  ? 'C:\\opt\\gluesync-conductor\\root-folder'
  : '/opt/gluesync-conductor/root-folder';
const PWD_ENV_FILE = '${PWD}/.env';

/**
 * Add ${PWD}/.env to services that should have it.
 * Forces it to be the ONLY env_file, overwriting any existing env_file.
 */
const addEnvFileToServices: AddEnvFile = (services, serviceIds) => {
  const rootFolderExists = existsSync(ROOT_FOLDER_PATH);

  if (!rootFolderExists) {
    console.log(
      `📋 addEnvFileToServices: root folder not mounted at ${ROOT_FOLDER_PATH}, skipping`,
    );
    return { services: {}, updatedIds: [] };
  }

  const envFilePath = join(ROOT_FOLDER_PATH, '.env');
  const envFileExists = existsSync(envFilePath);

  console.log(
    `📋 addEnvFileToServices: .env file ${envFileExists ? 'exists' : 'does not exist'} at ${envFilePath}`,
  );

  if (!envFileExists) {
    console.log('   ⏭️  Skipping - no .env file found');
    return { services: {}, updatedIds: [] };
  }

  const updatedServices: Record<string, any> = {};
  const updatedIds: string[] = [];

  serviceIds.forEach(id => {
    const service = services[id];
    if (!service) return;

    // Force replacement of env_file
    updatedServices[id] = { ...service, env_file: [PWD_ENV_FILE] };
    updatedIds.push(id);

    console.log(`   ❌ Forcing ${PWD_ENV_FILE} as the ONLY env_file for ${id}`);
  });

  return { services: updatedServices, updatedIds };
};

export default addEnvFileToServices;
