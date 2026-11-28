import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { join } from 'node:path';

import axios from 'axios';

import {
  LabelPrefix,
  RawComposeFile,
  RawComposeService,
} from '../../models/composeFile.model';
import { getDocker } from '../../utils/docker/getDocker';
import { getLogger } from '../../utils/logger';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import safeWriteFile from '../file/safeWriteFile/safeWriteFile';
import { ROOT_FOLDER_PATH } from '../healTraefikConf/healTraefikConf';
import planChronosScrape, {
  ChronosTarget,
  chronosTarget,
} from './planChronosScrape';

const LOG = '[chronos-scrape]';
const PROMETHEUS_CONF_IN_CONTAINER = /:(?:[a-zA-Z]:)?(\/etc\/prometheus[^:]*)/;
const CONF_FILE_NAME = 'prometheus.yml';

export type HealChronosScrapeOutcome = Readonly<{
  action: 'add' | 'none';
  reason: string;
  prometheus?: string;
}>;

export type HealChronosScrapeDeps = Readonly<{
  readCompose: () => Promise<Partial<RawComposeFile>>;
  exists: (path: string) => boolean;
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
  /** True when Chronos answers GET /metrics: older versions have no endpoint. */
  servesMetrics: (target: ChronosTarget) => Promise<boolean>;
  restartService: (serviceName: string) => Promise<number>;
}>;

const findService = (
  compose: Partial<RawComposeFile>,
  preferred: string,
  imagePart: string,
): string | null => {
  const services = compose.services ?? {};

  if (services[preferred]) {
    return preferred;
  }

  return (
    Object.keys(services).find(name =>
      (services[name]?.image ?? '').includes(imagePart),
    ) ?? null
  );
};

const confSource = (volume: string): string | null => {
  const normalized = volume.replace(/\\+/g, '/');
  const match = PROMETHEUS_CONF_IN_CONTAINER.exec(normalized);

  if (match?.index === undefined) {
    return null;
  }

  const source = normalized.slice(0, match.index).trim();

  return /\.ya?ml$/.test(match[1]) ? source : join(source, CONF_FILE_NAME);
};

/** The host file mounted as Prometheus' configuration, seen from the Conductor. */
export const resolvePrometheusConfPath = (
  service: Readonly<Partial<RawComposeService>> | undefined,
  exists: (path: string) => boolean,
): string | null => {
  const volumes = Array.isArray(service?.volumes)
    ? (service.volumes as ReadonlyArray<string>)
    : [];

  const candidates = [
    ...volumes
      .map(confSource)
      .filter((s): s is string => s !== null)
      .map(source =>
        source.startsWith('.')
          ? join(ROOT_FOLDER_PATH, source.replace(/^\.[\\/]?/, ''))
          : source,
      ),
    join(ROOT_FOLDER_PATH, 'prometheus', CONF_FILE_NAME),
  ];

  return candidates.find(exists) ?? null;
};

const none = (reason: string): HealChronosScrapeOutcome => {
  getLogger().info(`${LOG} nothing to change: ${reason}`);
  return { action: 'none', reason };
};

/**
 * Make the kit's Prometheus scrape Chronos' /metrics, so the Chronos dashboard
 * of the molo17/grafana image has data. Kits installed before Chronos had
 * metrics only scrape Core Hub. Idempotent; only adds, never changes a job.
 */
export const healChronosScrapeWith = async (
  deps: HealChronosScrapeDeps,
): Promise<HealChronosScrapeOutcome> => {
  const compose = await deps.readCompose();
  const chronosName = findService(
    compose,
    process.env.CHRONOS_NAME || 'gluesync-chronos',
    'gluesync-chronos',
  );

  if (!chronosName) {
    return none('no Chronos service in the stack');
  }

  const prometheusName = findService(compose, 'prometheus', 'prometheus');

  if (!prometheusName) {
    return none('no Prometheus service in the stack');
  }

  const confPath = resolvePrometheusConfPath(
    compose.services?.[prometheusName],
    deps.exists,
  );

  if (!confPath) {
    return none('the Prometheus configuration file is not reachable');
  }

  const target = chronosTarget(
    chronosName,
    compose.services?.[chronosName] ?? {},
  );
  const plan = planChronosScrape(await deps.read(confPath), target);

  if (plan.action === 'none') {
    return none(plan.reason);
  }

  if (!(await deps.servesMetrics(target))) {
    return none(`${chronosName} does not serve /metrics yet (older Chronos)`);
  }

  await deps.write(confPath, plan.text);
  const restarted = await deps.restartService(prometheusName);

  getLogger().info(
    `${LOG} added the ${target.scheme}://${target.host}:${target.port}/metrics job to ${confPath}; restarted ${restarted} ${prometheusName} container(s)`,
  );

  return {
    action: 'add',
    reason: `scraping ${target.host}:${target.port}`,
    prometheus: prometheusName,
  };
};

const servesMetrics = async (target: ChronosTarget): Promise<boolean> => {
  try {
    const response = await axios.get(
      `${target.scheme}://${target.host}:${target.port}/metrics`,
      {
        timeout: 5000,
        responseType: 'text',
        validateStatus: () => true,
        // The stack's services use self-signed certificates on the internal network
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      },
    );

    return (
      response.status === 200 &&
      String(response.data).includes('chronos_scheduler_running')
    );
  } catch {
    return false;
  }
};

const restartService = async (serviceName: string): Promise<number> => {
  const docker = getDocker();
  const labeled = await docker.listContainers({
    filters: { label: [`${LabelPrefix.COMPOSE}.service=${serviceName}`] },
  });

  await Promise.all(labeled.map(c => docker.getContainer(c.Id).restart()));

  return labeled.length;
};

const healChronosScrape = async (): Promise<HealChronosScrapeOutcome> => {
  try {
    return await healChronosScrapeWith({
      readCompose: () => readComposeFile({ raw: true }),
      exists: existsSync,
      read: path => readFile(path, 'utf8'),
      // In place: Prometheus mounts this file on its own, a new inode would not reach it
      write: (path, text) => safeWriteFile(path, text, { mode: 'in-place' }),
      servesMetrics,
      restartService,
    });
  } catch (error) {
    getLogger().error({ error }, `${LOG} failed`);
    return { action: 'none', reason: 'failed, see the log' };
  }
};

export default healChronosScrape;
