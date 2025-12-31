import {
  ComposePort,
  ComposeVolume,
  LabelPrefix,
} from '../../../models/composeFile.model';
import mergeComposeKeyValueField from '../mergeKeyValueStrings/mergeKeyValueStrings';
import { CreateComposeService } from './createComposeService.model';

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
      if (!raw) return acc;

      // Split into host, container, mode (mode is optional)
      const [host = '', container = '', mode] = raw.split(':');

      const hostT = host.trim();
      const containerT = container.trim();
      const modeT = mode?.trim();

      if (!hostT || !containerT) return acc;

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

      if (!hostT || !containerT) return acc;

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
  },
) => {
  const defaultLabels = {
    [`${LabelPrefix.CONDUCTOR}.service_id`]: serviceId,
    [`${LabelPrefix.CONDUCTOR}.type`]: serviceType,
  };

  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

  const basePath = isWindows ? 'C:\\opt\\gluesync' : '/opt/gluesync';
  const sharedPath = isWindows ? `${basePath}\\shared` : `${basePath}/shared`;
  const dataPath = isWindows ? `${basePath}\\data` : `${basePath}/data`;
  const logsPath = isWindows ? `${basePath}\\logs` : `${basePath}/logs`;

  const configDir = (process.env.GLUESYNC_CONFIG_DIR || '.').replace(
    /\/+$/,
    '',
  );

  const mountLegacyFileConfig =
    process.env.MOUNT_LEGACY_FILE_CONFIG?.toLowerCase() === 'true';

  const defaultVolumes = mountLegacyFileConfig
    ? [
        `${configDir}/gs-license.dat:${dataPath}${
          isWindows ? '\\' : '/'
        }gs-license.dat:ro`,
        `${configDir}/logback.xml:${dataPath}${
          isWindows ? '\\' : '/'
        }logback.xml:ro`,
        `${configDir}/security-config.json:${dataPath}${
          isWindows ? '\\' : '/'
        }security-config.json:ro`,
        `${configDir}/gluesync.com.jks:${dataPath}${
          isWindows ? '\\' : '/'
        }gluesync.com.jks:ro`,
        ...(serviceType === 'agent'
          ? [
              `./logs/${serviceId}:${logsPath}`,
              `./data/${serviceId}:${dataPath}`,
            ]
          : []),
      ]
    : [
        `${configDir}:${sharedPath}:ro`,
        ...(serviceType === 'agent'
          ? [
              `./logs/${serviceId}:${logsPath}`,
              `./data/${serviceId}:${dataPath}`,
            ]
          : []),
      ];

  return {
    image: `molo17/${imageName}:${tag || 'latest'}`,
    restart: 'unless-stopped',
    deploy:
      Object.keys(resources.limits || {}).length > 0 ||
      Object.keys(resources.reservations || {}).length > 0
        ? { resources }
        : undefined,
    labels: Object.entries({ ...labels, ...defaultLabels }).reduce<string[]>(
      (acc, [key, value]) => (value ? [...acc, `${key}=${value}`] : acc),
      [],
    ),
    environment: Object.entries({
      ...environment,
      ...(agentType && { TYPE: agentType }),
      AGENT_TAG: nickname || serviceId,
      ...(serviceType === 'agent' && {
        INITIAL_AGENT_ID: id,
        LOG_CONFIG_FILE: isWindows
          ? `${sharedPath}\\logback.xml`
          : '/opt/gluesync/shared/logback.xml',
        ...(isWindows && { GLUESYNC_HOST: ['gluesync-core-hub'] }),
      }),
    }).map(([key, value]) => `${key}=${value}`),

    ...(ports && ports.length > 0 && { ports: mapPorts(ports) }),

    volumes: mergeComposeKeyValueField(
      'volumes',
      defaultVolumes,
      mapVolumes(volumes),
    ),

    ...(isWindows && { networks: ['gluesync-windows-net'] }),

    healthcheck,
    depends_on: dependsOn,
  };
};

export default createComposeService;
