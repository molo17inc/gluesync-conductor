import { isMap, isNode, isSeq } from 'yaml';

import { RawComposeService } from '../../models/composeFile.model';
import { parseYamlMapping } from '../healTraefikConf/yamlLikeSource';

export const CHRONOS_JOB_NAME = 'gluesync-chronos';
const DEFAULT_CHRONOS_PORT = 1717;

export type ChronosTarget = Readonly<{
  scheme: 'http' | 'https';
  host: string;
  port: number;
}>;

export type ChronosScrapePlan =
  | Readonly<{ action: 'add'; text: string; target: ChronosTarget }>
  | Readonly<{ action: 'none'; reason: string }>;

const TRUE = new Set(['true', '1', 't', 'yes']);

const environmentOf = (
  service: Readonly<Partial<RawComposeService>>,
): Readonly<Record<string, string>> => {
  const env: unknown = service.environment;

  if (Array.isArray(env)) {
    return Object.fromEntries(
      env
        .filter((entry): entry is string => typeof entry === 'string')
        .map(entry => {
          const at = entry.indexOf('=');
          return at < 0
            ? [entry, '']
            : [entry.slice(0, at), entry.slice(at + 1)];
        }),
    );
  }

  return env && typeof env === 'object'
    ? Object.fromEntries(
        Object.entries(env as Record<string, unknown>).map(([k, v]) => [
          k,
          v === null || v === undefined ? '' : String(v),
        ]),
      )
    : {};
};

/**
 * Where Prometheus reaches Chronos on the stack network: the service name, the
 * PORT it listens on (1717 in the image) and the scheme set by SSL_ENABLED
 * (Chronos' own default is http).
 */
export const chronosTarget = (
  serviceName: string,
  service: Readonly<Partial<RawComposeService>>,
): ChronosTarget => {
  const env = environmentOf(service);
  const port = Number.parseInt(env.PORT ?? '', 10);

  return {
    scheme: TRUE.has((env.SSL_ENABLED ?? '').trim().toLowerCase())
      ? 'https'
      : 'http',
    host: serviceName,
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_CHRONOS_PORT,
  };
};

const jobBlock = (indent: string, target: ChronosTarget, eol: string): string =>
  [
    `${indent}- job_name: ${CHRONOS_JOB_NAME}`,
    `${indent}  # Chronos (scheduler) /metrics, added by Gluesync Conductor`,
    `${indent}  scheme: ${target.scheme}`,
    ...(target.scheme === 'https'
      ? [`${indent}  tls_config:`, `${indent}    insecure_skip_verify: true`]
      : []),
    `${indent}  static_configs:`,
    `${indent}    - targets:`,
    `${indent}        - ${target.host}:${target.port}`,
  ].join(eol);

/**
 * Plan the scrape job that makes Prometheus read Chronos' /metrics.
 *
 * Only bytes are appended after the last item of `scrape_configs`: comments,
 * the customer's other jobs and their formatting stay as they are. Anything
 * unexpected (not YAML, flow-style list, the job already there under any
 * scheme or port) leaves the file alone.
 */
const planChronosScrape = (
  prometheusYml: string,
  target: ChronosTarget,
): ChronosScrapePlan => {
  const doc = parseYamlMapping(prometheusYml);

  if (typeof doc === 'string') {
    return { action: 'none', reason: `prometheus.yml is ${doc}` };
  }

  const configs = doc.get('scrape_configs', true);

  if (!isSeq(configs)) {
    return {
      action: 'none',
      reason: 'prometheus.yml has no scrape_configs list',
    };
  }

  if (configs.flow) {
    return { action: 'none', reason: 'scrape_configs is a flow-style list' };
  }

  const jobs = configs.items.filter(isMap);
  const existing = jobs.find(
    job =>
      job.get('job_name') === CHRONOS_JOB_NAME ||
      JSON.stringify(job.toJSON()).includes(`${target.host}:`),
  );

  if (existing) {
    return { action: 'none', reason: 'Chronos is already scraped' };
  }

  const lastItem: unknown = configs.items.at(-1);
  const last = isNode(lastItem) ? lastItem : null;

  if (!last?.range) {
    return { action: 'none', reason: 'scrape_configs is empty' };
  }

  const eol = prometheusYml.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = prometheusYml.lastIndexOf('\n', last.range[0]) + 1;
  const prefix = prometheusYml.slice(lineStart, last.range[0]);
  const dash = prefix.indexOf('-');

  if (dash < 0 || prefix.slice(0, dash).trim() !== '') {
    return { action: 'none', reason: 'could not tell the list indentation' };
  }

  const indent = prefix.slice(0, dash);
  const end = last.range[1];
  const before = prometheusYml.slice(0, end).replace(/[ \t]+$/, '');
  const after = prometheusYml.slice(end);
  const separator = before.endsWith('\n') ? '' : eol;

  return {
    action: 'add',
    target,
    text: `${before}${separator}${jobBlock(indent, target, eol)}${eol}${after.replace(/^\r?\n/, '')}`,
  };
};

export default planChronosScrape;
