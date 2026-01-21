import { isAbsolute, resolve } from 'path';
import { getLogger } from '../../utils/logger';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAgentInfo from '../agentInfo/agentInfo';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';
import buildEnvFileConf from '../buildEnvFileConf/buildEnvFileConf';
import { EnvFile, EnvFileElement } from '../../models/composeFile.model';

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

// --- always return an array ---
const normalizeEnvFile = (
  envFile?: Readonly<EnvFile>,
): ReadonlyArray<EnvFileElement> => {
  if (!envFile) return [];

  // if envFile is already an array
  if (Array.isArray(envFile)) return envFile;

  // if envFile is a single string or object element
  return [envFile as EnvFileElement];
};

const canonicalizeEnvFileElement = (
  e: Readonly<EnvFileElement>,
): { path: string; required: boolean } => {
  if (typeof e === 'string') {
    return { path: e.replace(/\\+/g, '/').trim(), required: true };
  }

  return {
    path: (e.path ?? '').replace(/\\+/g, '/').trim(),
    required: e.required ?? true,
  };
};

// --- volumes helpers ---
const normalizeVolumeStr = (v: string): string =>
  v
    .trim()
    .replace(/^"+|"+$/g, '') // strip quotes if any
    .replace(/\\+/g, '/') // backslashes -> slashes
    .replace(/\/+/g, '/') // collapse multiple /
    .toLowerCase();

const normalizeVolumes = (volumes: unknown): string[] =>
  Array.isArray(volumes) ? volumes.filter(v => typeof v === 'string') : [];

const isRootFolderMount = (v: string): boolean => {
  const vv = normalizeVolumeStr(v);

  // Windows containers
  if (vv.includes('c:/opt/gluesync-conductor/root-folder')) return true;

  // Linux containers (match regardless of host prefix like "./:" or "/abs/path:")
  if (vv.includes('/opt/gluesync-conductor/root-folder')) return true;

  return false;
};

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
      return Object.entries(service.environment).map(
        ([k, v]) => `${k}=${v ?? ''}`,
      );
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
        return { value: '', changed: true };
      }
      return { value: e, changed: false };
    });

    return {
      healedEnvArray: mapped.filter(x => x.value).map(x => x.value),
      envChanged: mapped.some(x => x.changed),
    };
  })();

  // ----- ENV_FILE HEALING -----
  const basePath = process.env.BASE_PATH
    ? resolve(process.env.BASE_PATH)
    : undefined;

  const currentEnvFileRaw = normalizeEnvFile(service.env_file);

  const currentEnvFile: EnvFile = currentEnvFileRaw.map(e => {
    const obj = typeof e === 'string' ? { path: e } : e;

    try {
      if (
        basePath &&
        typeof obj.path === 'string' &&
        isAbsolute(obj.path) &&
        resolve(obj.path) === resolve(basePath, ENV_FILE)
      ) {
        return { ...obj, path: '.env', required: false };
      }
    } catch {
      /* noop */
    }

    return obj;
  });

  const finalEnvFile: EnvFile = buildEnvFileConf();

  const normalizedCurrentEnv = currentEnvFile.map(canonicalizeEnvFileElement);
  const normalizedFinalEnv = normalizeEnvFile(finalEnvFile).map(
    canonicalizeEnvFileElement,
  );

  const envFileChanged =
    normalizedCurrentEnv.length !== normalizedFinalEnv.length ||
    normalizedCurrentEnv.some((v, i) => {
      const f = normalizedFinalEnv[i];
      return v.path !== f.path || v.required !== f.required;
    });

  // ----- VOLUMES HEALING -----
  const currentVolumes = normalizeVolumes(service.volumes);

  const healedVolumes = currentVolumes.map(v =>
    v.trim() === BAD_VOLUME ? GOOD_VOLUME : v,
  );

  const hasRootFolderMount = healedVolumes.some(isRootFolderMount);

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
    ...(envFileChanged ? { env_file: finalEnvFile } : {}),
  };

  const {
    fullName,
    shortImageName,
    tag: currentTag = 'latest',
  } = parseImage(baseService.image);

  // ----- OPTIONAL RETAG (only if currentTag === 'latest') -----
  const newTag: string | null =
    currentTag === 'latest'
      ? (getVersionByChannel(await fetchAgentInfo(shortImageName), 'ga') ??
        null)
      : null;

  // ----- FINAL SERVICE -----
  const finalService: any = {
    ...baseService,
    volumes: finalVolumes,
    ...(newTag ? { image: `${fullName}:${newTag}` } : {}),
  };

  // ----- is changed DETECTION -----
  const isChanged =
    volumesChanged ||
    envChanged ||
    envFileChanged ||
    (!!newTag && newTag !== currentTag);

  if (!isChanged) {
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
