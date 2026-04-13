import { isAbsolute, resolve } from 'path';
import { getLogger } from '../../utils/logger';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAgentInfo from '../agentInfo/agentInfo';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';
import buildEnvFileConf from '../buildEnvFileConf/buildEnvFileConf';
import {
  EnvFile,
  EnvFileElement,
  RawComposeService,
} from '../../models/composeFile.model';

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
  if (!envFile) {
    return [];
  }

  // if envFile is already an array
  if (Array.isArray(envFile)) {
    return envFile;
  }

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
  if (vv.includes('c:/opt/gluesync-conductor/root-folder')) {
    return true;
  }

  // Linux containers (match regardless of host prefix like "./:" or "/abs/path:")
  if (vv.includes('/opt/gluesync-conductor/root-folder')) {
    return true;
  }

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
    if (Array.isArray(service.environment)) {
      return service.environment;
    }
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
    // Step 1: map legacy CORE_HUB_ADDRESS → GLUESYNC_HOST
    const mapped = rawEnvArray
      .map(e => {
        if (e.startsWith('CORE_HUB_ADDRESS=')) {
          const value = e.substring('CORE_HUB_ADDRESS='.length);

          if (!hasGluesyncHostInitial) {
            return `GLUESYNC_HOST=${value}`;
          }

          return '';
        }

        return e;
      })
      .filter(Boolean);

    const mappedChanged =
      mapped.length !== rawEnvArray.length ||
      rawEnvArray.some(e => e.startsWith('CORE_HUB_ADDRESS='));

    // Step 2: ensure GLUESYNC_HOST exists
    const hasGluesyncHost = mapped.some(e => e.startsWith('GLUESYNC_HOST='));

    const withHost = hasGluesyncHost
      ? mapped
      : [...mapped, `GLUESYNC_HOST=https://gluesync-core-hub:1717`];

    const hostAdded = !hasGluesyncHost;

    // Step 3: PROXY HEALING (Windows only)
    const hasProxyHttp = withHost.some(e => e.startsWith('PROXY_HTTP='));
    const hasProxyHttps = withHost.some(e => e.startsWith('PROXY_HTTPS='));

    const proxyEntries = isWindows
      ? [
          ...(hasProxyHttp
            ? []
            : [`PROXY_HTTP=${['$', '{PROXY_HTTP:-}'].join('')}`]),
          ...(hasProxyHttps
            ? []
            : [`PROXY_HTTPS=${['$', '{PROXY_HTTPS:-}'].join('')}`]),
        ]
      : [];

    const withProxy = [...withHost, ...proxyEntries];

    const proxyAdded = isWindows && (!hasProxyHttp || !hasProxyHttps);

    return {
      healedEnvArray: withProxy,
      envChanged: mappedChanged || hostAdded || proxyAdded,
    };
  })();

  // ----- ENV_FILE HEALING -----
  const basePath = process.env.BASE_PATH
    ? resolve(process.env.BASE_PATH)
    : undefined;

  const currentEnvFileRaw = normalizeEnvFile(service.env_file);

  const currentEnvFile: EnvFile = isWindows
    ? currentEnvFileRaw.map(e => (typeof e === 'string' ? { path: e } : e))
    : currentEnvFileRaw.map(e => {
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

  const finalEnvFile: EnvFile = isWindows ? currentEnvFile : buildEnvFileConf();

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

  // ----- NETWORK HEALING -----
  const networkName = isWindows ? 'gluesync-windows-net' : 'gluesync-net';

  const currentNetworks: ReadonlyArray<string> | undefined = (
    service as { networks?: ReadonlyArray<string> }
  ).networks;

  const networkChanged = !currentNetworks?.includes(networkName);

  const healedNetworks: ReadonlyArray<string> = (() => {
    if (currentNetworks && currentNetworks.length > 0) {
      if (currentNetworks.includes(networkName)) {
        return currentNetworks;
      }
      return [...currentNetworks, networkName];
    }
    return [networkName];
  })();

  // ----- CONTAINER_NAME HEALING -----
  const { container_name: containerName, ...serviceWithNoContainerName } =
    service as RawComposeService & { container_name?: string };

  const containerNameChanged = !!containerName;

  // ----- BASE SERVICE -----
  const baseService: any = {
    ...serviceWithNoContainerName,
    ...(envChanged ? { environment: healedEnvArray } : {}),
    ...(envFileChanged ? { env_file: finalEnvFile } : {}),
    ...(networkChanged ? { networks: healedNetworks } : {}),
  };

  // ----- DNS HEALING (Windows only) -----
  const { healedDns, dnsChanged } = (() => {
    if (!isWindows) {
      return { healedDns: baseService.dns, dnsChanged: false };
    }

    const defaultDns = ['8.8.8.8', '1.1.1.1'];

    const needsHealing =
      !Array.isArray(baseService.dns) || baseService.dns.length === 0;

    return needsHealing
      ? { healedDns: defaultDns, dnsChanged: true }
      : { healedDns: baseService.dns, dnsChanged: false };
  })();

  const {
    fullName,
    shortImageName,
    tag: currentTag = 'latest',
  } = parseImage(baseService.image);

  // ----- OPTIONAL RETAG -----
  const newTag: string | null =
    currentTag === 'latest'
      ? (getVersionByChannel(await fetchAgentInfo(shortImageName), 'ga') ??
        null)
      : null;

  // ----- FINAL SERVICE -----
  const finalService: any = {
    ...baseService,
    volumes: finalVolumes,
    ...(dnsChanged ? { dns: healedDns } : {}),
    ...(newTag ? { image: `${fullName}:${newTag}` } : {}),
  };

  // ----- CHANGE DETECTION -----
  const isChanged =
    containerNameChanged ||
    volumesChanged ||
    envChanged ||
    envFileChanged ||
    networkChanged ||
    dnsChanged ||
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

  if (dnsChanged) {
    logger.info('[conductor-healer] DNS healed (8.8.8.8, 1.1.1.1)');
  }

  logger.info('[conductor-healer] reboot needed to heal');
  return true;
};

export default healConductorConf;
