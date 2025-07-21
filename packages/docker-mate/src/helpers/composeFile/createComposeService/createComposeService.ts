import mergeComposeKeyValueField from '../mergeKeyValueStrings/mergeKeyValueStrings';
import { CreateComposeService } from './createComposeService.model';

const createComposeService: CreateComposeService = (
  serviceType,
  {
    imageName,
    type,
    nickname,
    tag,
    environment = {},
    ports = [],
    volumes = [],
    labels = {},
  },
) => {
  const containerName = `${imageName}-${type}-${serviceType}`;
  const containerDisplayName = nickname || containerName;

  const defaultLabels = {
    'com.molo17.conductor.unique_id': containerDisplayName,
    'com.molo17.conductor.versiontag': tag || 'latest',
    'com.molo17.conductor.type': serviceType,
  };

  return {
    image: `molo17/${imageName}:${tag || 'latest'}`,
    container_name: containerDisplayName,
    restart: 'unless-stopped',
    labels: Object.entries({
      ...labels,
      ...defaultLabels,
    }).map(([key, value]) => `${key}=${value}`),
    environment: Object.entries({
      type,
      maxRamPercentage: 90.0,
      LOG_CONFIG_FILE: '/opt/gluesync/data/logback.xml',
      GLUESYNC_MODULE_TAG: 'gluesync-conductor',
      ...environment,
    }).map(([key, value]) => `${key}=${value}`),
    ports,
    volumes: mergeComposeKeyValueField(
      'volumes',
      [
        './gs-license.dat:/opt/gluesync/data/gs-license.dat:ro',
        './logback.xml:/opt/gluesync/data/logback.xml:ro',
        './security-config.json:/opt/gluesync/data/security-config.json:ro',
        './gluesync.com.jks:/opt/gluesync/data/gluesync.com.jks:ro',
        './bootstrap-core-hub.json:/opt/gluesync/data/bootstrap-core-hub.json:ro',
        `./${containerName}:/opt/gluesync/data`,
      ],
      volumes,
    ),
  };
};

export default createComposeService;
