import { ComposePort, ComposeVolume } from '../../../models/composeFile.model';
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
    tag,
    environment = {},
    ports = [],
    volumes = [],
    labels = {},
    resources,
    healthcheck,
    dependsOn,
  },
) => {
  const isIntegrationTest =
    process.env.IS_INTEGRATION_TEST.toLowerCase() === 'true';
  const containerName =
    nickname ??
    `${imageName}${agentType ? `-${agentType}` : ''}-${serviceType}`;

  const defaultLabels = {
    'com.molo17.conductor.service_id': id,
    'com.molo17.conductor.versiontag': tag || undefined,
    'com.molo17.conductor.type': serviceType,
  };

  // remove trailing /
  const configDir = (process.env.GLUESYNC_CONFIG_DIR || '.').replace(
    /\/+$/,
    '',
  );

  const defaultVolumes = isIntegrationTest
    ? []
    : [
        `${configDir}/gs-license.dat:/opt/gluesync/data/gs-license.dat:ro`,
        `${configDir}/logback.xml:/opt/gluesync/data/logback.xml:ro`,
        `${configDir}/security-config.json:/opt/gluesync/data/security-config.json:ro`,
        `${configDir}/gluesync.com.jks:/opt/gluesync/data/gluesync.com.jks:ro`,
        `${configDir}/bootstrap-core-hub.json:/opt/gluesync/data/bootstrap-core-hub.json:ro`,
        `./${containerName}:/opt/gluesync/data`,
      ];

  return {
    image: `molo17/${imageName}:${tag || 'latest'}`,
    container_name: containerName,
    restart: 'unless-stopped',
    deploy: { resources },
    labels: Object.entries({ ...labels, ...defaultLabels }).reduce<string[]>(
      (acc, [key, value]) => (value ? [...acc, `${key}=${value}`] : acc),
      [],
    ),
    environment: Object.entries({
      ...(agentType ? { TYPE: agentType } : {}),
      GLUESYNC_MODULE_TAG: 'conductor',
      INITIAL_AGENT_ID: id,
      ...environment,
    }).map(([key, value]) => `${key}=${value}`),
    ports: mapPorts(ports),
    volumes: mergeComposeKeyValueField(
      'volumes',
      defaultVolumes,
      mapVolumes(volumes),
    ),
    healthcheck,
    depends_on: dependsOn,
  };
};

export default createComposeService;
