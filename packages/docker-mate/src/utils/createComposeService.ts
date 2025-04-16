import { ComposeService } from '../models/composeFile.model';

interface CreateComposeServiceOptions {
  imageName: string;
  type: string;
  name?: string;
  tag?: string;
  environment?: Record<string, string>;
  ports?: readonly string[];
  volumes?: readonly string[];
  labels?: string[];
  extraEnv?: Record<string, string>;
}

export function createComposeService({
  imageName,
  type,
  name,
  tag,
  environment = {},
  ports = [],
  volumes = [],
  labels = [],
  extraEnv = {},
}: CreateComposeServiceOptions): ComposeService {
  const containerName = `${imageName}-${type}-agent`;
  const containerDisplayName = name || containerName;
  return {
    image: `molo17/${imageName}:${tag || 'latest'}`,
    container_name: containerDisplayName,
    restart: 'unless-stopped',
    labels,
    environment: Object.entries({
      type,
      maxRamPercentage: 90.0,
      LOG_CONFIG_FILE: '/opt/gluesync/data/logback.xml',
      ...extraEnv,
      ...environment,
    }).map(([key, value]) => `${key}=${value}`),
    ports,
    volumes: [
      './gs-license.dat:/opt/gluesync/data/gs-license.dat:ro',
      './logback.xml:/opt/gluesync/data/logback.xml:ro',
      './security-config.json:/opt/gluesync/data/security-config.json:ro',
      './gluesync.com.jks:/opt/gluesync/data/gluesync.com.jks:ro',
      './bootstrap-core-hub.json:/opt/gluesync/data/bootstrap-core-hub.json:ro',
      `./${containerName}:/opt/gluesync/data`,
      ...volumes,
    ],
  };
}
