import { existsSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../../utils/logger';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAgentInfo from '../agentInfo/agentInfo';
import { AgentInfoResponse } from '../agentInfo/agentInfo.model';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

// Platform-specific volume paths
const BAD_VOLUME = isWindows
  ? '.\\logs\\conductor:C:\\opt\\gluesync-conductor\\logs'
  : './logs/conductor:/opt/gluesync-conductor/logs';

const GOOD_VOLUME = isWindows
  ? '.\\logs:C:\\opt\\gluesync-conductor\\logs'
  : './logs:/opt/gluesync-conductor/logs';

const REQUIRED_ROOT_FOLDER_MOUNT_VOLUME = isWindows
  ? '.\\:C:\\opt\\gluesync-conductor\\root-folder'
  : './:/opt/gluesync-conductor/root-folder';

const ENV_FILE = '.env';

// Platform-specific root folder path (where it's mounted in conductor)
const ROOT_FOLDER_PATH = isWindows
  ? 'C:\\opt\\gluesync-conductor\\root-folder'
  : '/opt/gluesync-conductor/root-folder';

const healConductorConf = async (): Promise<boolean> => {
  const logger = getLogger();
  const conductorServiceName =
    process.env.CONDUCTOR_NAME || 'gluesync-conductor';

  const composeJson = await readComposeFile({ raw: true });

  const service = composeJson.services?.[conductorServiceName];
  if (!service) {
    logger.info('[conductor-healer] nothing to heal (service not found)');
    return false;
  }

  // Normalize environment to an array of strings
  const rawEnvArray: string[] = (() => {
    if (Array.isArray(service.environment)) {
      return service.environment as string[];
    }

    if (service.environment && typeof service.environment === 'object') {
      return Object.entries(service.environment).map(([k, v]) => `${k}=${v}`);
    }

    return [];
  })();

  const hasGluesyncHostInitial = rawEnvArray.some(e =>
    e.startsWith('GLUESYNC_HOST='),
  );

  const { healedEnvArray, envChanged } = (() => {
    const mapped = rawEnvArray.map(e => {
      if (e.startsWith('CORE_HUB_ADDRESS=')) {
        const value = e.substring('CORE_HUB_ADDRESS='.length);
        if (!hasGluesyncHostInitial) {
          return { value: `GLUESYNC_HOST=${value}`, changed: true };
        }
        // GLUESYNC_HOST already present: drop CORE_HUB_ADDRESS
        return { value: '', changed: true };
      }
      return { value: e, changed: false };
    });

    const filtered = mapped.filter(x => x.value !== '').map(x => x.value);

    const changed = mapped.some(x => x.changed);

    return { healedEnvArray: filtered, envChanged: changed };
  })();

  // Check if .env file exists in root folder
  const envFilePath = join(ROOT_FOLDER_PATH, ENV_FILE);
  const envFileExists = existsSync(envFilePath);

  logger.info(
    `[conductor-healer] .env file ${envFileExists ? 'exists' : 'does not exist'} at ${envFilePath}`,
  );

  // Normalize env_file to array
  const normalizeEnvFile = (envFile: any): ReadonlyArray<string> => {
    if (!envFile) return [];
    if (Array.isArray(envFile)) return envFile;
    if (typeof envFile === 'string') return [envFile];
    return [];
  };

  const currentEnvFile = normalizeEnvFile(service.env_file);
  const hasEnvFile = currentEnvFile.includes(ENV_FILE);

  // Only add .env if:
  // 1. File exists in root folder
  // 2. Not already in env_file array
  const shouldAddEnvFile = envFileExists && !hasEnvFile;
  const shouldRemoveEnvFile = !envFileExists && hasEnvFile;

  const finalEnvFile = (() => {
    if (shouldAddEnvFile) {
      logger.info('[conductor-healer] adding .env to env_file');
      return [ENV_FILE, ...currentEnvFile];
    }
    if (shouldRemoveEnvFile) {
      logger.info(
        '[conductor-healer] removing .env from env_file (file does not exist)',
      );
      return currentEnvFile.filter(f => f !== ENV_FILE);
    }
    return currentEnvFile;
  })();

  const envFileChanged =
    finalEnvFile.length !== currentEnvFile.length ||
    !finalEnvFile.every((f, i) => f === currentEnvFile[i]);

  const baseService = {
    ...service,
    ...(envChanged ? { environment: healedEnvArray } : {}),
    ...(envFileChanged ? { env_file: finalEnvFile } : {}),
  };

  const {
    fullName,
    shortImageName,
    tag: currentTag = 'latest',
  } = parseImage(baseService.image);

  // Normalize volumes to array of strings
  const normalizeVolumes = (volumes: any): ReadonlyArray<string> => {
    if (!volumes) return [];
    if (Array.isArray(volumes)) {
      return volumes.filter((v): v is string => typeof v === 'string');
    }
    return [];
  };

  const currentVolumes = normalizeVolumes(baseService.volumes);

  // Check if root folder mount exists (platform-aware)
  const hasRootFolderMount = currentVolumes.some(vol =>
    isWindows
      ? vol.includes('C:\\opt\\gluesync-conductor\\root-folder')
      : vol.includes(':/opt/gluesync-conductor/root-folder'),
  );

  // Fix bad log volume path
  const healedVolumes = currentVolumes.map(vol =>
    vol.trim() === BAD_VOLUME ? GOOD_VOLUME : vol,
  );

  // Add root folder mount if missing
  const finalVolumes = hasRootFolderMount
    ? healedVolumes
    : [...healedVolumes, REQUIRED_ROOT_FOLDER_MOUNT_VOLUME];

  const volumesChanged =
    finalVolumes.length !== currentVolumes.length ||
    finalVolumes.some((v, i) => v !== currentVolumes[i]);

  // Only retag when current tag is "latest"
  if (currentTag !== 'latest') {
    const healedVolumesNonLatest = Array.isArray(baseService.volumes)
      ? baseService.volumes.map(vol =>
          typeof vol === 'string' && vol.trim() === BAD_VOLUME
            ? GOOD_VOLUME
            : vol,
        )
      : baseService.volumes;

    const volumesChangedNonLatest = Array.isArray(baseService.volumes)
      ? healedVolumesNonLatest?.some((v, i) => v !== baseService.volumes?.[i])
      : false;

    if (!volumesChangedNonLatest && !envChanged) {
      logger.info('[conductor-healer] nothing to heal');
      return false;
    }

    const updatedServicesNonLatest = {
      ...composeJson.services,
      [conductorServiceName]: {
        ...baseService,
        volumes: finalVolumes,
      },
    };

    const updatedComposeNonLatest = {
      ...composeJson,
      services: updatedServicesNonLatest,
    };

    await writeComposeFile(updatedComposeNonLatest);

    logger.info('[conductor-healer] reboot needed to heal');
    return true;
  }

  // Tag is "latest": fix volumes AND maybe update tag
  const healedVolumes = Array.isArray(baseService.volumes)
    ? baseService.volumes.map(vol =>
        typeof vol === 'string' && vol.trim() === BAD_VOLUME
          ? GOOD_VOLUME
          : vol,
      )
    : baseService.volumes;

  const volumesChanged = Array.isArray(baseService.volumes)
    ? healedVolumes?.some((v, i) => v !== baseService.volumes?.[i])
    : false;

  if (!volumesChanged && !envChanged) {
    logger.info('[conductor-healer] nothing to heal');
    return false;
  }

  const agentInfo: AgentInfoResponse = await fetchAgentInfo(shortImageName);
  const newTag = getVersionByChannel(agentInfo, 'ga');

  if (!newTag) {
    const updatedServicesNoTag = {
      ...composeJson.services,
      [conductorServiceName]: {
        ...baseService,
        volumes: finalVolumes,
      },
    };

    const updatedComposeNoTag = {
      ...composeJson,
      services: updatedServicesNoTag,
    };

    await writeComposeFile(updatedComposeNoTag);

    logger.info('[conductor-healer] reboot needed to heal');
    return true;
  }

  const newImage = `${fullName}:${newTag}`;

  const updatedServices = {
    ...composeJson.services,
    [conductorServiceName]: {
      ...baseService,
      volumes: finalVolumes,
      image: newImage,
    },
  };

  const updatedCompose = {
    ...composeJson,
    services: updatedServices,
  };

  await writeComposeFile(updatedCompose);

  logger.info('[conductor-healer] reboot needed to heal');
  return true;
};

export default healConductorConf;
