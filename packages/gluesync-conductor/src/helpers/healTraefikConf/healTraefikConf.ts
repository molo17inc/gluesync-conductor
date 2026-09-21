import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

import {
  LabelPrefix,
  RawComposeFile,
  RawComposeService,
} from '../../models/composeFile.model';
import { getDocker } from '../../utils/docker/getDocker';
import { getLogger } from '../../utils/logger';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

const ROOT_FOLDER_PATH = isWindows
  ? String.raw`C:\opt\gluesync-conductor\root-folder`
  : '/opt/gluesync-conductor/root-folder';

const DEFAULT_TRAEFIK_CONF_PATH = join(
  ROOT_FOLDER_PATH,
  'proxy',
  'traefik.yml',
);
const STATIC_CONF_FILE_NAME = 'traefik.yml';
const WEB_ENTRYPOINT = 'web';
const WEBSECURE_ENTRYPOINT = 'websecure';

const logger = getLogger();

type TraefikStaticConf = Readonly<{
  entryPoints?: Record<string, any>;
  [key: string]: any;
}>;

const findProxyServiceName = (
  composeJson: Partial<RawComposeFile>,
): string | null => {
  const services = composeJson.services ?? {};
  const preferred = process.env.REVERSE_PROXY_NAME || 'reverse-proxy';

  if (services[preferred]) {
    return preferred;
  }

  return (
    Object.keys(services).find(name =>
      (services[name]?.image ?? '').includes('traefik'),
    ) ?? null
  );
};

/**
 * Extract the host-side source path of the volume that mounts Traefik's
 * static configuration into the proxy container (file or directory mount).
 */
const volumeSourceForTraefikConf = (volume: string): string | null => {
  const normalized = volume.replace(/\\+/g, '/');
  const match = /:(?:[a-zA-Z]:)?(\/etc\/traefik[^:]*)/.exec(normalized);

  if (match?.index === undefined) {
    return null;
  }

  const source = normalized.slice(0, match.index).trim();
  const target = match[1];

  return target.endsWith('.yml') || target.endsWith('.yaml')
    ? source
    : join(source, STATIC_CONF_FILE_NAME);
};

const hostSourceToRootFolderPath = (source: string): string =>
  source.startsWith('.')
    ? join(ROOT_FOLDER_PATH, source.replace(/^\.[\\/]?/, ''))
    : source;

const resolveTraefikConfPath = (
  service: Readonly<RawComposeService> | undefined,
): string | null => {
  const volumes = Array.isArray(service?.volumes)
    ? (service.volumes as ReadonlyArray<string>)
    : [];

  const candidates = [
    ...volumes
      .map(volumeSourceForTraefikConf)
      .filter((s): s is string => s !== null)
      .map(hostSourceToRootFolderPath),
    DEFAULT_TRAEFIK_CONF_PATH,
  ];

  return candidates.find(existsSync) ?? null;
};

const withHttpsRedirect = (conf: TraefikStaticConf): TraefikStaticConf => ({
  ...conf,
  entryPoints: {
    ...conf.entryPoints,
    [WEB_ENTRYPOINT]: {
      ...conf.entryPoints?.[WEB_ENTRYPOINT],
      http: {
        ...conf.entryPoints?.[WEB_ENTRYPOINT]?.http,
        redirections: {
          ...conf.entryPoints?.[WEB_ENTRYPOINT]?.http?.redirections,
          entryPoint: {
            to: WEBSECURE_ENTRYPOINT,
            scheme: 'https',
            permanent: true,
          },
        },
      },
    },
  },
});

const restartProxyContainer = async (serviceName: string): Promise<void> => {
  const docker = getDocker();

  const labeled = await docker.listContainers({
    filters: {
      label: [`${LabelPrefix.COMPOSE}.service=${serviceName}`],
    },
  });

  const containers =
    labeled.length > 0
      ? labeled
      : (await docker.listContainers()).filter(c =>
          (c.Names ?? []).some(n => n.includes(serviceName)),
        );

  if (containers.length === 0) {
    logger.warn(
      `[traefik-healer] no running container found for ${serviceName}, skipping restart`,
    );
    return;
  }

  await Promise.all(containers.map(c => docker.getContainer(c.Id).restart()));

  logger.info(
    `[traefik-healer] restarted ${serviceName} (${containers.length} container(s))`,
  );
};

/**
 * Ensure the Traefik `web` (:80) entrypoint redirects all traffic to
 * `websecure` (:443). Patches the static traefik.yml mounted through the
 * conductor root-folder, then restarts the reverse-proxy container.
 * Idempotent: no-op when the redirect is already in place.
 * Returns the healed reverse-proxy service name, or null when nothing changed.
 */
const healTraefikConf = async (
  composeJson?: Partial<RawComposeFile>,
): Promise<string | null> => {
  try {
    const compose = composeJson ?? (await readComposeFile({ raw: true }));
    const serviceName = findProxyServiceName(compose);

    if (!serviceName) {
      logger.info('[traefik-healer] no reverse-proxy service found, skipping');
      return null;
    }

    const confPath = resolveTraefikConfPath(compose.services?.[serviceName]);

    if (!confPath) {
      logger.info('[traefik-healer] traefik static conf not found, skipping');
      return null;
    }

    const conf = parse(await readFile(confPath, 'utf8')) as
      | TraefikStaticConf
      | null
      | undefined;

    if (!conf || typeof conf !== 'object') {
      logger.warn(`[traefik-healer] ${confPath} is empty or invalid, skipping`);
      return null;
    }

    if (!conf.entryPoints?.[WEB_ENTRYPOINT]) {
      logger.info('[traefik-healer] no web entrypoint, skipping');
      return null;
    }

    if (!conf.entryPoints?.[WEBSECURE_ENTRYPOINT]) {
      logger.info('[traefik-healer] no websecure entrypoint, skipping');
      return null;
    }

    const currentTarget =
      conf.entryPoints[WEB_ENTRYPOINT]?.http?.redirections?.entryPoint?.to;

    if (currentTarget === WEBSECURE_ENTRYPOINT) {
      logger.info('[traefik-healer] nothing to heal');
      return null;
    }

    await writeFile(
      confPath,
      stringify(withHttpsRedirect(conf), { indent: 2 }),
      'utf8',
    );

    logger.info(`[traefik-healer] http->https redirect written to ${confPath}`);

    await restartProxyContainer(serviceName);

    return serviceName;
  } catch (error) {
    logger.error({ error }, '[traefik-healer] failed to heal traefik conf');
    return null;
  }
};

export default healTraefikConf;
