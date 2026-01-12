import { existsSync } from 'fs';
import { join } from 'path';
import { AddEnvFile } from './AddEnvFileToServices.model';
import buildEnvFileConf from '../buildEnvFileConf/buildEnvFileConf';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

const ROOT_FOLDER_PATH = isWindows
  ? 'C:\\opt\\gluesync-conductor\\root-folder'
  : '/opt/gluesync-conductor/root-folder';

const ENV_FILE_NAME = '.env';

/**
 * Add env_file to the specified services.
 * Forces it to be the ONLY env_file, overwriting any existing env_file.
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

      const envFile = buildEnvFileConf();

      const newUpdatedServices = {
        ...acc.updatedServices,
        [id]: { ...service, env_file: envFile },
      };
      const newUpdatedIds = [...acc.updatedIds, id];

      console.log(
        `📋 addEnvFileToServices: forcing env_file for ${id}: ${ENV_FILE_NAME} + ${join(
          ROOT_FOLDER_PATH,
          ENV_FILE_NAME,
        )}`,
      );

      return {
        updatedServices: newUpdatedServices,
        updatedIds: newUpdatedIds,
      };
    },
    { updatedServices: {} as Record<string, any>, updatedIds: [] as string[] },
  );

  return { services: result.updatedServices, updatedIds: result.updatedIds };
};

export default addEnvFileToServices;
