import {
  DiagnosisCode,
  DiagnosisOwner,
  DiagnosisParams,
  ResolutionCode,
} from './diagnosis.model';

// Data plus the function that words it for this code: one entry per code, by design.
// eslint-disable-next-line functional/no-mixed-types
type CatalogEntry = Readonly<{
  owner: DiagnosisOwner;
  /** HTTP status Conductor uses when this diagnosis is the reason a request failed. */
  httpStatus: number;
  resolutionCodes: ReadonlyArray<ResolutionCode>;
  /** The keys `params` carries for this code. Part of the contract: translators need them. */
  paramKeys: ReadonlyArray<string>;
  exampleParams: DiagnosisParams;
  title: string;
  summary: (params: DiagnosisParams) => string;
}>;

const text = (params: DiagnosisParams, key: string, fallback = '?'): string => {
  const value = params[key];
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value === undefined ? fallback : String(value);
};

const BYTES_PER_MIB = 1024 * 1024;

// Sizes for people: KiB below one MiB so a small file does not read as "0.0 MiB".
const size = (params: DiagnosisParams, key: string): string | undefined => {
  const value = params[key];
  if (typeof value !== 'number') {
    return undefined;
  }
  return value < BYTES_PER_MIB
    ? `${Math.ceil(value / 1024)} KiB`
    : `${(value / BYTES_PER_MIB).toFixed(1)} MiB`;
};

// The disk figures a failing write could not supply are left out of `params`
// (a kernel ENOSPC knows neither the size nor the free space), so the text
// mentions only what it has.
const diskDetail = (params: DiagnosisParams): string => {
  const needed = size(params, 'neededBytes');
  const available = size(params, 'availableBytes');

  if (needed && available) {
    return ` (${needed} needed, ${available} available)`;
  }
  return needed ? ` (${needed} needed)` : '';
};

const BACKOFFICE = 'api.backoffice.molo17.com';

/**
 * Everything MOLO17-specific that Conductor knows about a diagnosis code.
 * The English here is only the `fallback`: the UI owns user-facing wording and
 * translates by `code`, so none of this text is a translation source.
 */
export const DIAGNOSIS_CATALOG: Readonly<Record<DiagnosisCode, CatalogEntry>> =
  {
    CONNECTIVITY_OK: {
      owner: 'none',
      httpStatus: 200,
      resolutionCodes: [],
      paramKeys: [],
      exampleParams: {},
      title: 'All connectivity checks passed',
      summary: () => 'This host can reach the MOLO17 services it needs.',
    },
    TRANSIENT_FAILURE: {
      owner: 'unknown',
      httpStatus: 502,
      resolutionCodes: ['WAIT_AND_RETRY', 'CONTACT_SUPPORT_WITH_DETAILS'],
      paramKeys: ['errorKind'],
      exampleParams: { errorKind: 'timeout' },
      title: 'A request failed but the services are reachable now',
      summary: params =>
        `The request failed (${text(params, 'errorKind', 'unknown error')}) but every connectivity check passes now. This is usually a temporary network interruption.`,
    },
    CONDUCTOR_UPDATING: {
      owner: 'local',
      httpStatus: 503,
      resolutionCodes: ['WAIT_FOR_CONDUCTOR_UPDATE'],
      paramKeys: [],
      exampleParams: {},
      title: 'Conductor is updating',
      summary: () =>
        'Conductor is applying an update and temporarily refuses requests.',
    },
    DOCKER_NOT_READY: {
      owner: 'local',
      httpStatus: 503,
      resolutionCodes: ['WAIT_AND_RETRY', 'CHECK_DOCKER_DAEMON'],
      paramKeys: [],
      exampleParams: {},
      title: 'Docker is not ready yet',
      summary: () =>
        'Conductor cannot reach the Docker daemon yet. This is common right after a restart.',
    },
    COREHUB_UNAVAILABLE: {
      owner: 'local',
      httpStatus: 503,
      resolutionCodes: ['WAIT_AND_RETRY', 'CHECK_COREHUB_RUNNING'],
      paramKeys: [],
      exampleParams: {},
      title: 'Core Hub is not responding',
      summary: () => 'Conductor could not verify your session with Core Hub.',
    },
    PROXY_UNREACHABLE: {
      owner: 'customer',
      httpStatus: 502,
      resolutionCodes: ['CHECK_PROXY_SETTINGS', 'CONTACT_SUPPORT_WITH_DETAILS'],
      paramKeys: ['host', 'port'],
      exampleParams: { host: 'proxy.example.com', port: 3128 },
      title: 'The configured proxy cannot be reached',
      summary: params =>
        `Conductor cannot open a connection to the proxy ${text(params, 'host')}:${text(params, 'port')}.`,
    },
    PROXY_AUTH_REQUIRED: {
      owner: 'customer',
      httpStatus: 502,
      resolutionCodes: ['CHECK_PROXY_CREDENTIALS', 'CHECK_PROXY_SETTINGS'],
      paramKeys: [],
      exampleParams: {},
      title: 'The proxy requires valid credentials',
      summary: () => 'The proxy rejected the request with HTTP 407.',
    },
    NO_INTERNET: {
      owner: 'customer',
      httpStatus: 502,
      resolutionCodes: ['CHECK_INTERNET_CONNECTION', 'CHECK_PROXY_SETTINGS'],
      paramKeys: ['viaProxy'],
      exampleParams: { viaProxy: false },
      title: 'This host has no internet access',
      summary: () =>
        'Neither the connection by address nor the one by name could be established.',
    },
    DNS_FAILURE: {
      owner: 'customer',
      httpStatus: 502,
      resolutionCodes: ['CHECK_DNS_SETTINGS'],
      paramKeys: ['host'],
      exampleParams: { host: BACKOFFICE },
      title: 'Host names cannot be resolved',
      summary: params =>
        `This host reaches the internet by address but cannot resolve ${text(params, 'host')}.`,
    },
    TLS_INSPECTION: {
      owner: 'customer',
      httpStatus: 502,
      resolutionCodes: ['TRUST_CORPORATE_CA', 'ALLOWLIST_MOLO17_HOSTS'],
      paramKeys: ['host'],
      exampleParams: { host: BACKOFFICE },
      title: 'A secure connection could not be verified',
      summary: params =>
        `The certificate presented for ${text(params, 'host')} is not trusted. This usually means a corporate proxy or firewall is inspecting HTTPS traffic.`,
    },
    MOLO17_HOSTS_BLOCKED: {
      owner: 'customer',
      httpStatus: 502,
      resolutionCodes: ['ALLOWLIST_MOLO17_HOSTS', 'CHECK_PROXY_SETTINGS'],
      paramKeys: ['hosts'],
      exampleParams: { hosts: [BACKOFFICE] },
      title: 'MOLO17 services are blocked from this host',
      summary: params =>
        `The internet is reachable but ${text(params, 'hosts')} cannot be. A firewall or proxy is probably blocking them.`,
    },
    BACKOFFICE_UNREACHABLE_FROM_HOST: {
      owner: 'customer',
      httpStatus: 502,
      resolutionCodes: ['ALLOWLIST_MOLO17_HOSTS', 'CHECK_PROXY_SETTINGS'],
      paramKeys: ['host'],
      exampleParams: { host: BACKOFFICE },
      title: 'The update service cannot be reached from this host',
      summary: params =>
        `MOLO17 reports no problem, but this host cannot reach ${text(params, 'host')}.`,
    },
    REGISTRY_UNREACHABLE: {
      owner: 'customer',
      httpStatus: 502,
      resolutionCodes: ['CHECK_DOCKER_HUB_ACCESS', 'CHECK_PROXY_SETTINGS'],
      paramKeys: ['host'],
      exampleParams: { host: 'registry-1.docker.io' },
      title: 'The image registry cannot be reached',
      summary: params =>
        `This host cannot reach the container registry ${text(params, 'host')}, so new images cannot be downloaded.`,
    },
    UNEXPECTED_RESPONSE_FROM_INTERMEDIARY: {
      owner: 'customer',
      httpStatus: 502,
      resolutionCodes: ['CHECK_PROXY_SETTINGS', 'ALLOWLIST_MOLO17_HOSTS'],
      paramKeys: ['status', 'viaProxy'],
      exampleParams: { status: 503, viaProxy: true },
      title: 'A proxy or firewall answered instead of MOLO17',
      summary: params =>
        `The request was answered with HTTP ${text(params, 'status')} by a device between this host and MOLO17, not by MOLO17 itself.`,
    },
    OTA_SERVICE_DOWN: {
      owner: 'molo17',
      httpStatus: 503,
      resolutionCodes: ['CHECK_STATUS_PAGE', 'WAIT_AND_RETRY'],
      paramKeys: ['status', 'host', 'reason'],
      exampleParams: { status: 503, host: BACKOFFICE },
      title: 'The MOLO17 update service is temporarily unavailable',
      summary: () =>
        'The update service is not responding correctly. This is on the MOLO17 side and nothing needs to change on your system.',
    },
    BACKOFFICE_REQUEST_REJECTED: {
      owner: 'molo17',
      httpStatus: 502,
      resolutionCodes: ['CONTACT_SUPPORT_WITH_DETAILS'],
      paramKeys: ['status', 'host'],
      exampleParams: { status: 404, host: BACKOFFICE },
      title: 'The update service rejected the request',
      summary: params =>
        `The update service answered HTTP ${text(params, 'status')}. This is not a network problem.`,
    },
    SWARM_NOT_MANAGER: {
      owner: 'local',
      httpStatus: 503,
      resolutionCodes: ['RUN_CONDUCTOR_ON_SWARM_MANAGER'],
      paramKeys: [],
      exampleParams: {},
      title: 'Conductor is not running on a swarm manager',
      summary: () =>
        'Docker Swarm services can only be managed from a manager node, and this Conductor runs on a worker.',
    },
    SWARM_UNSUPPORTED: {
      owner: 'local',
      httpStatus: 501,
      resolutionCodes: [],
      paramKeys: ['feature'],
      exampleParams: { feature: 'migration to 2.x' },
      title: 'Not available on Docker Swarm',
      summary: params =>
        `${text(params, 'feature')} is not supported when Gluesync runs as a Docker Swarm stack.`,
    },
    UNKNOWN: {
      owner: 'unknown',
      httpStatus: 502,
      resolutionCodes: ['CONTACT_SUPPORT_WITH_DETAILS'],
      paramKeys: [],
      exampleParams: {},
      title: 'The problem could not be identified',
      summary: () =>
        'The checks did not point to a single cause. Share the technical details with support.',
    },
    DISK_FULL: {
      owner: 'customer',
      httpStatus: 507,
      resolutionCodes: ['FREE_DISK_SPACE', 'CONTACT_SUPPORT_WITH_DETAILS'],
      // path, neededBytes and availableBytes are each omitted when the failing write did not know them.
      paramKeys: ['path', 'neededBytes', 'availableBytes'],
      exampleParams: {
        path: '/opt/gluesync/docker-compose.yml',
        neededBytes: 52428800,
        availableBytes: 1048576,
      },
      title: 'Not enough free disk space',
      summary: params =>
        `There is not enough free disk space to write ${text(params, 'path', 'the Gluesync configuration')}${diskDetail(params)}. Nothing was changed.`,
    },
    COMPOSE_FILE_CORRUPT: {
      owner: 'local',
      httpStatus: 500,
      resolutionCodes: ['CONTACT_SUPPORT_WITH_DETAILS'],
      paramKeys: ['path', 'problem'],
      exampleParams: {
        path: '/opt/gluesync/docker-compose.yml',
        problem: 'the file is empty',
      },
      title: 'docker-compose.yml is empty or corrupt',
      summary: params =>
        `${text(params, 'path', 'docker-compose.yml')} is unusable (${text(params, 'problem', 'unreadable')}) and no last-good backup could restore it. Conductor refused to write over it.`,
    },
  };

export const RESOLUTION_FALLBACK: Readonly<Record<ResolutionCode, string>> = {
  WAIT_AND_RETRY: 'Wait a few minutes and try again.',
  CHECK_STATUS_PAGE: 'Check the MOLO17 status page for ongoing incidents.',
  WAIT_FOR_CONDUCTOR_UPDATE:
    'Wait for the Conductor update to finish. The page recovers on its own.',
  CHECK_DOCKER_DAEMON: 'Make sure the Docker service is running on this host.',
  CHECK_COREHUB_RUNNING: 'Make sure the Core Hub service is running.',
  CHECK_INTERNET_CONNECTION:
    "Check this host's network connection and default gateway.",
  CHECK_DNS_SETTINGS: 'Check the DNS servers configured on this host.',
  ALLOWLIST_MOLO17_HOSTS:
    'Ask your network team to allow outbound HTTPS (port 443) to the hosts listed in the connectivity details.',
  CHECK_PROXY_SETTINGS:
    'Verify the PROXY_HTTPS / PROXY_HTTP settings of Conductor and that the proxy allows these hosts.',
  CHECK_PROXY_CREDENTIALS:
    'Verify the proxy username and password in PROXY_HTTPS / PROXY_HTTP.',
  TRUST_CORPORATE_CA:
    "Install your organisation's root certificate on this host, or exclude the MOLO17 hosts from HTTPS inspection.",
  CHECK_DOCKER_HUB_ACCESS:
    'Allow outbound HTTPS to Docker Hub (registry-1.docker.io, auth.docker.io, production.cloudflare.docker.com).',
  RUN_CONDUCTOR_ON_SWARM_MANAGER:
    'Deploy the Conductor service with the placement constraint node.role == manager.',
  CONTACT_SUPPORT_WITH_DETAILS:
    'Contact MOLO17 support and attach the technical details.',
  FREE_DISK_SPACE:
    'Free up disk space on the volume that holds the Gluesync folder (docker-compose.yml), then try again.',
};
