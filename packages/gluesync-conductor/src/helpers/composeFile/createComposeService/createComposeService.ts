import {
  ComposePort,
  ComposeServiceDeploy,
  ComposeVolume,
  LabelPrefix,
} from '../../../models/composeFile.model';
import { ConductorServiceTypes } from '../../../models/conductor.model';
import { sanitizeChronosRouterLabels } from '../../healChronosTraefikRule/chronosRouterRule';
import buildEnvFileConf from '../../buildEnvFileConf/buildEnvFileConf';
import mergeComposeKeyValueField from '../mergeKeyValueStrings/mergeKeyValueStrings';
import {
  CreateComposeService,
  CreateComposeServiceOptions,
} from './createComposeService.model';

// Universal port mapper function
const mapPorts = (ports: ReadonlyArray<string> | ReadonlyArray<ComposePort>) =>
  ports.reduce<ReadonlyArray<string>>((acc, port) => {
    // Check if it's a string or object
    if (typeof port === 'string') {
      // Handle string format: "host:container" Es:"8080:80" / or "host:container/protocol" Es: Es:"8080:80/tcp"
      const [host = '', containerAndProtocol = ''] = port.trim().split(':');
      const [container = '', protocol = ''] = containerAndProtocol.split('/');

      if (!host || !container) {
        return acc;
      }

      return [...acc, `${host}:${container}${protocol ? `/${protocol}` : ''}`];
    }

    if (typeof port === 'object' && port !== null) {
      // Handle object format: { host, container, protocol }
      const { host = '', container = '', protocol } = port;
      if (!String(host).trim() || !String(host).trim()) {
        return acc;
      }
      return [
        ...acc,
        `${host}:${container}${String(host)?.trim() ? `/${protocol}` : ''}`,
      ];
    }
    // Fallback for unexpected formats
    return acc;
  }, []);

const mapVolumes = (
  volumes: ReadonlyArray<string> | ReadonlyArray<ComposeVolume>,
) =>
  volumes.reduce<ReadonlyArray<string>>((acc, vol) => {
    // String input: "host:container[:mode]"
    if (typeof vol === 'string') {
      const raw = vol.trim();
      if (!raw) {
        return acc;
      }

      // Split into host, container, mode (mode is optional)
      const [host = '', container = '', mode] = raw.split(':');

      const hostT = host.trim();
      const containerT = container.trim();
      const modeT = mode?.trim();

      if (!hostT || !containerT) {
        return acc;
      }

      // Normalize mode to only 'rw' or 'ro' if present; ignore others
      const normalizedMode =
        modeT === 'rw' || modeT === 'ro' ? modeT : undefined;

      return [
        ...acc,
        `${hostT}:${containerT}${normalizedMode ? `:${normalizedMode}` : ''}`,
      ];
    }

    // Object input: { host, container, mode? }
    if (typeof vol === 'object' && vol !== null) {
      const hostT = String(vol.host ?? '').trim();
      const containerT = String(vol.container ?? '').trim();
      const modeT = vol.mode?.toString().trim();

      if (!hostT || !containerT) {
        return acc;
      }

      const normalizedMode =
        modeT === 'rw' || modeT === 'ro' ? modeT : undefined;

      return [
        ...acc,
        `${hostT}:${containerT}${normalizedMode ? `:${normalizedMode}` : ''}`,
      ];
    }

    // Unexpected type: skip
    return acc;
  }, []);

type Resources = Readonly<NonNullable<ComposeServiceDeploy['resources']>>;

type PlatformPaths = Readonly<{
  sharedPath: string;
  dataPath: string;
  logsPath: string;
}>;

const resolvePlatformPaths = (isWindows: boolean): PlatformPaths => {
  const basePath = isWindows ? String.raw`C:\opt\gluesync` : '/opt/gluesync';

  return {
    sharedPath: isWindows
      ? String.raw`${basePath}\shared`
      : `${basePath}/shared`,
    dataPath: isWindows ? String.raw`${basePath}\data` : `${basePath}/data`,
    logsPath: isWindows ? String.raw`${basePath}\logs` : `${basePath}/logs`,
  };
};

// Not a `/\/+$/` replace: that one is quadratic on a long run of slashes
const stripTrailingSlashes = (value: string): string =>
  value.slice(0, value.split('').findLastIndex(char => char !== '/') + 1);

const buildDefaultVolumes = (
  serviceType: ConductorServiceTypes,
  serviceId: string,
  isWindows: boolean,
  { sharedPath, dataPath, logsPath }: PlatformPaths,
): ReadonlyArray<string> => {
  const configDir = stripTrailingSlashes(
    process.env.GLUESYNC_CONFIG_DIR || '.',
  );
  const separator = isWindows ? '\\' : '/';

  const mountLegacyFileConfig =
    process.env.MOUNT_LEGACY_FILE_CONFIG?.toLowerCase() === 'true';

  const agentVolumes =
    serviceType === 'agent'
      ? [`./logs/${serviceId}:${logsPath}`, `./data/${serviceId}:${dataPath}`]
      : [];

  return mountLegacyFileConfig
    ? [
        `${configDir}/gs-license.dat:${dataPath}${separator}gs-license.dat:ro`,
        `${configDir}/logback.xml:${dataPath}${separator}logback.xml:ro`,
        `${configDir}/security-config.json:${dataPath}${separator}security-config.json:ro`,
        `${configDir}/gluesync.com.jks:${dataPath}${separator}gluesync.com.jks:ro`,
        ...agentVolumes,
      ]
    : [`${configDir}:${sharedPath}:ro`, ...agentVolumes];
};

const hasResourceSettings = (resources: Resources): boolean =>
  Object.keys(resources.limits || {}).length > 0 ||
  Object.keys(resources.reservations || {}).length > 0;

// Swarm ignores `restart:`, `depends_on` and the container name: the
// restart policy lives in `deploy`, and tasks find each other by service name
// on the overlay network the stack declares
const buildSwarmDeploy = (
  resources: Resources,
  currentDeploy?: ComposeServiceDeploy,
) => ({
  ...currentDeploy,
  restart_policy: currentDeploy?.restart_policy ?? {
    condition: 'on-failure' as const,
  },
  // What the request says replaces the old limits, like in compose mode
  resources: hasResourceSettings(resources) ? resources : undefined,
});

const buildDeploy = (
  resources: Resources,
  swarm: CreateComposeServiceOptions['swarm'],
) => {
  if (swarm) {
    return buildSwarmDeploy(resources, swarm.currentDeploy);
  }

  return hasResourceSettings(resources) ? { resources } : undefined;
};

const buildEnvironment = (
  serviceType: ConductorServiceTypes,
  {
    id,
    serviceId,
    agentType,
    nickname,
    environment,
    isWindows,
    sharedPath,
  }: Readonly<
    Pick<
      CreateComposeServiceOptions,
      'id' | 'serviceId' | 'agentType' | 'nickname'
    > & {
      environment: Readonly<Record<string, string>>;
      isWindows: boolean;
      sharedPath: string;
    }
  >,
): ReadonlyArray<string> =>
  Object.entries({
    ...environment,
    ...(agentType && { TYPE: agentType }),
    TAG: nickname || serviceId,
    ...(serviceType === 'agent' && {
      INITIAL_AGENT_ID: id,
      LOG_CONFIG_FILE: isWindows
        ? String.raw`${sharedPath}\logback.xml`
        : '/opt/gluesync/shared/logback.xml',
      ...(isWindows && { GLUESYNC_HOST: ['gluesync-core-hub'] }),
    }),
  }).map(([key, value]) => `${key}=${value}`);

const createComposeService: CreateComposeService = (
  serviceType,
  {
    id,
    imageName,
    agentType,
    nickname,
    serviceId,
    tag,
    environment = {},
    ports,
    volumes = [],
    labels = {},
    resources = {},
    healthcheck,
    dependsOn,
    swarm,
  },
) => {
  const labelsForCompose = sanitizeChronosRouterLabels(labels);

  const defaultLabels = {
    [`${LabelPrefix.CONDUCTOR}.service_id`]: serviceId,
    [`${LabelPrefix.CONDUCTOR}.type`]: serviceType,
  };

  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;
  const paths = resolvePlatformPaths(isWindows);
  const defaultVolumes = buildDefaultVolumes(
    serviceType,
    serviceId,
    isWindows,
    paths,
  );

  return {
    image: `molo17/${imageName}:${tag || 'latest'}`,
    ...(!swarm && { restart: 'unless-stopped' }),
    deploy: buildDeploy(resources, swarm),
    labels: Object.entries({
      ...labelsForCompose,
      ...defaultLabels,
    }).reduce<string[]>(
      (acc, [key, value]) => (value ? [...acc, `${key}=${value}`] : acc),
      [],
    ),
    environment: buildEnvironment(serviceType, {
      id,
      serviceId,
      agentType,
      nickname,
      environment,
      isWindows,
      sharedPath: paths.sharedPath,
    }),
    ...(ports && ports.length > 0 && { ports: mapPorts(ports) }),
    volumes: mergeComposeKeyValueField(
      'volumes',
      defaultVolumes,
      mapVolumes(volumes),
    ),

    networks: [isWindows && !swarm ? 'gluesync-windows-net' : 'gluesync-net'],
    healthcheck,
    depends_on: swarm ? undefined : dependsOn,
    env_file: buildEnvFileConf(),
  };
};

export default createComposeService;
