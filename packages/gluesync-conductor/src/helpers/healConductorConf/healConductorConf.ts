import { existsSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
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
// Avoid `${` pattern in a plain string while preserving runtime value
const PWD_ENV_FILE = ['${', 'PWD}/.env'].join('');

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
    if (Array.isArray(service.environment)) return service.environment;
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

    return {
      healedEnvArray: mapped.filter(x => x.value).map(x => x.value),
      envChanged: mapped.some(x => x.changed),
    };
  })();

  // Check if .env file exists in root folder
  const basePath = process.env.BASE_PATH
    ? resolve(process.env.BASE_PATH)
    : undefined;

  const envFilePath = join(ROOT_FOLDER_PATH, ENV_FILE);
  const envFileExists = existsSync(envFilePath);

  logger.info(
    `[conductor-healer] host .env ${
      envFileExists ? 'exists' : 'does not exist'
    } at ${envFilePath}`,
  );

  // Normalize env_file to array
  const normalizeEnvFile = (envFile: any): string[] => {
    if (!envFile) return [];
    if (Array.isArray(envFile))
      return envFile.filter(v => typeof v === 'string');
    if (typeof envFile === 'string') return [envFile];
    return [];
  };

  const currentEnvFileRaw = normalizeEnvFile(service.env_file);

  const currentEnvFile = currentEnvFileRaw.map(f => {
    try {
      if (
        basePath &&
        isAbsolute(f) &&
        resolve(f) === resolve(basePath, ENV_FILE)
      ) {
        return PWD_ENV_FILE;
      }
    } catch {
      /* noop */
    }
    return f;
  });

  const finalEnvFile: string[] = envFileExists ? [PWD_ENV_FILE] : [];

  const normalizeEnvStr = (v: string) => v.trim();
  const normalizedCurrentEnv = currentEnvFile.map(normalizeEnvStr);
  const normalizedFinalEnv = finalEnvFile.map(normalizeEnvStr);

  const envFileChanged =
    normalizedCurrentEnv.length !== normalizedFinalEnv.length ||
    normalizedCurrentEnv.some((v, i) => v !== normalizedFinalEnv[i]);

  // ----- VOLUMES HEALING -----
  const normalizeVolumes = (volumes: any): string[] =>
    Array.isArray(volumes) ? volumes.filter(v => typeof v === 'string') : [];

  const currentVolumes = normalizeVolumes(service.volumes);

  const normalizeVolumeStr = (v: string) => v.replace(/\\+/g, '/').trim();

  const hasRootFolderMount = currentVolumes.some(v =>
    isWindows
      ? v.includes('C:/opt/gluesync-conductor/root-folder')
      : v.includes(':/opt/gluesync-conductor/root-folder'),
  );

  const healedVolumes = currentVolumes.map(v =>
    v.trim() === BAD_VOLUME ? GOOD_VOLUME : v,
  );

  const finalVolumes = hasRootFolderMount
    ? healedVolumes
    : [...healedVolumes, REQUIRED_ROOT_FOLDER_MOUNT_VOLUME];

  const normalizedCurrentVolumes = currentVolumes.map(normalizeVolumeStr);
  const normalizedFinalVolumes = finalVolumes.map(normalizeVolumeStr);

  const volumesChanged =
    normalizedCurrentVolumes.length !== normalizedFinalVolumes.length ||
    normalizedCurrentVolumes.some((v, i) => v !== normalizedFinalVolumes[i]);

  // ----- BASE SERVICE -----
  const baseService: any = {
    ...service,
    ...(envChanged ? { environment: healedEnvArray } : {}),
    ...(finalEnvFile.length > 0 ? { env_file: finalEnvFile } : {}),
  };

  const {
    fullName,
    shortImageName,
    tag: currentTag = 'latest',
  } = parseImage(baseService.image);

  // ----- NON-LATEST: ONLY HEAL CONFIG -----
  if (currentTag !== 'latest') {
    const finalServiceNonLatest = {
      ...baseService,
      volumes: finalVolumes,
    };

    const changedNonLatest = volumesChanged || envChanged || envFileChanged;

    if (!changedNonLatest) {
      logger.info('[conductor-healer] nothing to heal');
      return false;
    }

    await writeComposeFile({
      ...composeJson,
      services: {
        ...composeJson.services,
        [conductorServiceName]: finalServiceNonLatest,
      },
    });

    logger.info('[conductor-healer] reboot needed to heal');
    return true;
  }

  // ----- LATEST: HEAL + RETAG VIA AgentInfoResponse -----
  const agentInfo: AgentInfoResponse = await fetchAgentInfo(shortImageName);
  const newTag = getVersionByChannel(agentInfo, 'ga') ?? undefined;

  const finalService: any = {
    ...baseService,
    volumes: finalVolumes,
    ...(newTag ? { image: `${fullName}:${newTag}` } : {}),
  };

  const changed =
    volumesChanged ||
    envChanged ||
    envFileChanged ||
    (!!newTag && newTag !== currentTag);

  if (!changed) {
    logger.info('[conductor-healer] nothing to heal');
    return false;
  }

  await writeComposeFile({
    ...composeJson,
    services: {
      ...composeJson.services,
      [conductorServiceName]: finalService,
    },
  });

  logger.info('[conductor-healer] reboot needed to heal');
  return true;
};

export default healConductorConf;
