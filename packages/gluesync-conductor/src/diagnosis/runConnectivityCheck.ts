import { readComposeFile } from '../helpers/composeFile/readComposeFile/readComposeFile';
import parseImage from '../helpers/parseImage/parseImage';
import { getProxyInfo } from '../utils/axiosWithRetry';
import { getLogger } from '../utils/logger';
import { Diagnosis } from './diagnosis.model';
import diagnose from './diagnose';
import {
  DiagnosisConfig,
  getBackofficeProbeUrl,
  getDiagnosisConfig,
} from './config';
import runHttpProbe, { HttpProbeSpec } from './probes/httpProbe';
import runTcpProbe from './probes/tcpProbe';
import { ProbeResult } from './probes/probe.model';
import { interpretStatusFeed } from './probes/statusFeed';
import { ConnectivityFacts } from './rules/facts.model';

export type ConnectivityScope = 'ota';

export type RunConnectivityCheckOptions = Readonly<{
  scope?: ConnectivityScope;
  /** The real request that just failed; sharpens the verdict. */
  trigger?: ProbeResult;
  /** Skip the probe cache (still rate limited). */
  refresh?: boolean;
}>;

export type RunConnectivityCheck = (
  options?: RunConnectivityCheckOptions,
) => Promise<Diagnosis>;

type CollectedFacts = Omit<ConnectivityFacts, 'trigger'>;

const logger = getLogger();

const DOCKER_HUB = 'registry-1.docker.io';
const MAX_REGISTRIES = 3;

const normalizeRegistryHost = (registry: string): string =>
  registry === '' || registry === 'docker.io' || registry === 'index.docker.io'
    ? DOCKER_HUB
    : registry;

// The registries that compose images are pulled from: Docker Hub unless an
// image names another one. Unreadable compose file falls back to Docker Hub.
const resolveRegistryHosts = async (
  config: DiagnosisConfig,
): Promise<ReadonlyArray<string>> => {
  if (config.registryOverride) {
    return config.registryOverride;
  }

  try {
    const compose = await readComposeFile();
    const hosts = Object.values(compose.services ?? {})
      .map(service =>
        normalizeRegistryHost(parseImage(service?.image).registry),
      )
      .filter((host, index, all) => all.indexOf(host) === index)
      .slice(0, MAX_REGISTRIES);

    return hosts.length > 0 ? hosts : [DOCKER_HUB];
  } catch {
    return [DOCKER_HUB];
  }
};

// An entry is a bare host (probed over HTTPS) or a full base URL.
const registryProbeUrl = (entry: string): string =>
  `${entry.includes('://') ? entry.replace(/\/+$/, '') : `https://${entry}`}/v2/`;

const buildProbeSpecs = (
  config: DiagnosisConfig,
  registryHosts: ReadonlyArray<string>,
): ReadonlyArray<HttpProbeSpec> => [
  {
    id: 'internet-ip',
    url: config.internetIpUrl,
    timeoutMs: config.probeTimeoutMs,
    isHealthyStatus: status => status >= 200 && status < 300,
  },
  {
    id: 'internet-name',
    url: config.internetNameUrl,
    timeoutMs: config.probeTimeoutMs,
    isHealthyStatus: status => status >= 200 && status < 300,
  },
  {
    id: 'backoffice',
    url: getBackofficeProbeUrl(config),
    timeoutMs: config.probeTimeoutMs,
    isHealthyStatus: status => status >= 200 && status < 300,
    expectMolo17Origin: true,
  },
  // A registry answers 401 (auth required) or 200 on /v2/ when it works. 403 or
  // 407 means something in between refuses the request.
  ...registryHosts.map(
    (host): HttpProbeSpec => ({
      id: 'registry',
      url: registryProbeUrl(host),
      timeoutMs: config.probeTimeoutMs,
      isHealthyStatus: status => status === 200 || status === 401,
    }),
  ),
];

const collectFacts = async (
  config: DiagnosisConfig,
): Promise<CollectedFacts> => {
  const proxy = getProxyInfo();
  const registryHosts = await resolveRegistryHosts(config);

  const [proxyProbe, statusOutcome, ...outcomes] = await Promise.all([
    proxy
      ? runTcpProbe(proxy.host, proxy.port, config.probeTimeoutMs)
      : Promise.resolve(undefined),
    runHttpProbe({
      id: 'status-feed',
      url: config.statusApiUrl,
      timeoutMs: config.probeTimeoutMs,
      isHealthyStatus: status => status >= 200 && status < 300,
      expectMolo17Origin: true,
      captureBody: true,
    }),
    ...buildProbeSpecs(config, registryHosts).map(spec => runHttpProbe(spec)),
  ]);

  const statusFeed = interpretStatusFeed(statusOutcome, {
    serviceId: config.otaStatusServiceId,
    staleAfterMs: config.statusStaleAfterMs,
    now: Date.now(),
  });

  return {
    proxy: proxy
      ? {
          configured: true,
          host: proxy.host,
          port: proxy.port,
          reachable: proxyProbe?.reachable,
        }
      : { configured: false },
    probes: [
      ...(proxyProbe ? [proxyProbe] : []),
      ...outcomes.map(outcome => outcome.result),
      statusFeed.probe,
    ],
    statusFeed,
  };
};

// One probe run is shared by every check inside its window, so a page that
// fires many failing requests at once costs a single set of probes.
const cache = new Map<
  ConnectivityScope,
  Readonly<{ startedAt: number; facts: Promise<CollectedFacts> }>
>();

const getFacts = (
  scope: ConnectivityScope,
  refresh: boolean,
  config: DiagnosisConfig,
): Promise<CollectedFacts> => {
  const entry = cache.get(scope);
  const age = entry ? Date.now() - entry.startedAt : Number.POSITIVE_INFINITY;
  const maxAge = refresh ? config.minRefreshIntervalMs : config.cacheTtlMs;

  if (entry && age < maxAge) {
    return entry.facts;
  }

  const facts = collectFacts(config);
  cache.set(scope, { startedAt: Date.now(), facts });
  // A rejected run must not poison the cache.
  facts.catch(() => cache.delete(scope));

  return facts;
};

export const clearConnectivityCache = (): void => cache.clear();

const runConnectivityCheck: RunConnectivityCheck = async ({
  scope = 'ota',
  trigger,
  refresh = false,
} = {}) => {
  const config = getDiagnosisConfig();
  const facts = await getFacts(scope, refresh, config);
  const diagnosis = diagnose({ ...facts, trigger });

  logger.info(
    {
      code: diagnosis.code,
      owner: diagnosis.owner,
      confidence: diagnosis.confidence,
      triggered: trigger !== undefined,
      checks: diagnosis.checks.map(({ id, ok }) => `${id}=${ok}`),
    },
    '[diagnosis] connectivity check',
  );

  return diagnosis;
};

export default runConnectivityCheck;
