import type { RawComposeFile } from '../../models/composeFile.model';
import {
  EditDisasterRecoveryCompose,
  FindDisasterRecoveryBlocker,
  RenderDisasterRecoveryEnvFile,
} from './disasterRecoveryCompose.model';

/** Only Core Hub reads this file: the secrets of the pair stay out of every other container. */
export const DR_ENV_FILE_NAME = 'gluesync-dr.env';

/** Marks the variables that this setup wrote: only those are removed by a disable. */
export const MANAGED_BY_KEY = 'GS_DR_MANAGED_BY';
export const MANAGED_BY_VALUE = 'conductor';

/**
 * What only the first site records besides the variables of Core Hub: the rest of its pairing
 * code (its own URL, the node id of the peer and the lease TTL, which a manual pair does not
 * pass to Core Hub), so that the code can be shown again. Core Hub ignores these.
 */
export const PAIRING_FIRST_URL_KEY = 'GS_DR_PAIRING_FIRST_URL';
export const PAIRING_JOINER_NODE_ID_KEY = 'GS_DR_PAIRING_JOINER_NODE_ID';
export const PAIRING_LEASE_TTL_KEY = 'GS_DR_PAIRING_LEASE_TTL_SECONDS';

export const SINK_PORT = 1718;
export const CONTROL_PORT = 1719;

// A Core Hub gets 10 s to stop by default; Litestream alone may take 10 s to push its last writes
export const STOP_GRACE_PERIOD = '60s';
const STOP_GRACE_SECONDS = 60;

export const CONTROL_URL_KEY = 'GS_DR_CONTROL_URL';
const VARIABLE_PREFIX = 'GS_DR_';

const CHRONOS_DATA_DIR_KEY = 'DATA_DIR';
const CHRONOS_DEFAULT_DATA_DIR = '/app/data';
const CHRONOS_DEFAULT_DATA_DIR_WINDOWS = String.raw`C:\app\data`;

// Where the data directory of Chronos is mounted into Core Hub (GS_DR_CHRONOS_DIR)
const CORE_HUB_CHRONOS_DIR = '/opt/gluesync/chronos';
const CORE_HUB_CHRONOS_DIR_WINDOWS = String.raw`C:\opt\gluesync\chronos`;

const ROOT_FOLDER = '/opt/gluesync-conductor/root-folder';
const ROOT_FOLDER_WINDOWS = String.raw`C:\opt\gluesync-conductor\root-folder`;

type Loose = Readonly<Record<string, any>>;

// The compose file is edited as plain data: its services are typed by the model, but the
// fields read here come in more than one shape (list or map, short or long syntax)
const asService = (service: unknown): Loose => (service ?? {}) as Loose;

const asList = (value: unknown): ReadonlyArray<any> => {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

export const chronosDataDir = (windows: boolean): string =>
  windows ? CHRONOS_DEFAULT_DATA_DIR_WINDOWS : CHRONOS_DEFAULT_DATA_DIR;

export const coreHubChronosDir = (windows: boolean): string =>
  windows ? CORE_HUB_CHRONOS_DIR_WINDOWS : CORE_HUB_CHRONOS_DIR;

// ---------------------------------------------------------------- environment

const environmentKey = (entry: unknown): string | undefined =>
  typeof entry === 'string' && entry.includes('=')
    ? entry.slice(0, entry.indexOf('=')).trim()
    : undefined;

const environmentKeys = (environment: unknown): ReadonlyArray<string> => {
  if (Array.isArray(environment)) {
    return environment
      .map(environmentKey)
      .filter((key): key is string => key !== undefined);
  }

  return environment && typeof environment === 'object'
    ? Object.keys(environment)
    : [];
};

const environmentValue = (
  environment: unknown,
  key: string,
): string | undefined => {
  if (Array.isArray(environment)) {
    const entry = environment.find(item => environmentKey(item) === key) as
      | string
      | undefined;

    return entry?.slice(entry.indexOf('=') + 1).trim();
  }

  const value = (environment as Loose | undefined)?.[key];

  return value === undefined || value === null ? undefined : String(value);
};

const withEnvironmentValue = (
  environment: unknown,
  key: string,
  value: string,
): unknown =>
  Array.isArray(environment) || environment === undefined
    ? [
        ...asList(environment).filter(entry => environmentKey(entry) !== key),
        `${key}=${value}`,
      ]
    : { ...(environment as Loose), [key]: value };

const withoutEnvironmentKey = (
  environment: unknown,
  key: string,
): unknown | undefined => {
  if (Array.isArray(environment)) {
    const kept = environment.filter(entry => environmentKey(entry) !== key);

    return kept.length === 0 ? undefined : kept;
  }

  if (environment && typeof environment === 'object') {
    const kept = Object.fromEntries(
      Object.entries(environment as Loose).filter(([name]) => name !== key),
    );

    return Object.keys(kept).length === 0 ? undefined : kept;
  }

  return environment;
};

// ------------------------------------------------------------------- env_file

const rootFolder = (windows: boolean): string =>
  windows ? ROOT_FOLDER_WINDOWS : ROOT_FOLDER;

// Like the kit's `.env` entries: the file next to the compose file, and the same file as the
// Conductor mounts it (compose runs from inside the Conductor, where the relative path is not found)
const drEnvFileEntries = (
  windows: boolean,
): ReadonlyArray<{ path: string; required: false }> => [
  { path: DR_ENV_FILE_NAME, required: false },
  {
    path: `${rootFolder(windows)}${windows ? '\\' : '/'}${DR_ENV_FILE_NAME}`,
    required: false,
  },
];

const envFilePath = (entry: unknown): string =>
  typeof entry === 'string' ? entry : String((entry as Loose)?.path ?? '');

const isDrEnvFileEntry = (entry: unknown): boolean =>
  envFilePath(entry).replaceAll('\\', '/').split('/').at(-1)?.trim() ===
  DR_ENV_FILE_NAME;

// ---------------------------------------------------------------------- ports

const containerPort = (entry: unknown): number | undefined => {
  if (typeof entry === 'number') {
    return entry;
  }

  if (typeof entry === 'string') {
    const [last] = entry.split('/')[0].split(':').slice(-1);

    return /^\d+$/.test(last) ? Number(last) : undefined;
  }

  const target = (entry as Loose | undefined)?.target;

  return target === undefined ? undefined : Number(target);
};

const HOST_IP = /^((?:\d{1,3}\.){3}\d{1,3}|\[[0-9A-Fa-f:.]+\]):\d+:\d+/;

const hostIp = (entry: unknown): string | undefined => {
  if (typeof entry === 'string') {
    return HOST_IP.exec(entry)?.[1];
  }

  const ip = (entry as Loose | undefined)?.host_ip;

  if (typeof ip !== 'string' || ip === '') {
    return undefined;
  }

  return ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
};

const publishedPorts = (
  existing: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> => {
  // The ports go out on the same host address as the ones Core Hub already publishes
  const ip = existing.map(hostIp).find(found => found !== undefined);
  const prefix = ip ? `${ip}:` : '';
  const missing = [SINK_PORT, CONTROL_PORT].filter(
    port => !existing.some(entry => containerPort(entry) === port),
  );

  return [...existing, ...missing.map(port => `${prefix}${port}:${port}`)];
};

// -------------------------------------------------------------------- volumes

type Mount = Readonly<{
  /** Host path or volume name; undefined for a mount that has no source (anonymous volume, tmpfs). */
  source: string | undefined;
  long: boolean;
  type?: string;
}>;

const normalizePath = (path: string, windows: boolean): string => {
  const slashes = path.replaceAll('\\', '/').replace(/\/+$/, '');

  return windows ? slashes.toLowerCase() : slashes;
};

const targetVariants = (target: string): ReadonlyArray<string> => [
  target,
  `${target}/`,
  `${target}\\`,
  target.replaceAll('\\', '/'),
  `${target.replaceAll('\\', '/')}/`,
];

// Short syntax is `source:target[:options]`: the target is looked up in the entry because a
// Windows target (`C:\app\data`) has a colon of its own
const matchShortVolume = (
  entry: string,
  target: string,
  windows: boolean,
): Mount | undefined => {
  const haystack = windows ? entry.toLowerCase() : entry;

  return targetVariants(windows ? target.toLowerCase() : target)
    .map(variant => {
      const at = haystack.indexOf(`:${variant}`);
      const after = at < 0 ? '' : haystack.slice(at + 1 + variant.length);

      return at > 0 && (after === '' || after.startsWith(':'))
        ? ({ source: entry.slice(0, at), long: false } satisfies Mount)
        : undefined;
    })
    .find(found => found !== undefined);
};

const mountAt = (
  volumes: unknown,
  target: string,
  windows: boolean,
): Mount | undefined =>
  asList(volumes)
    .map((entry): Mount | undefined => {
      if (typeof entry === 'string') {
        return matchShortVolume(entry, target, windows);
      }

      const long = entry as Loose | undefined;

      return long?.target !== undefined &&
        normalizePath(String(long.target), windows) ===
          normalizePath(target, windows)
        ? {
            source: typeof long.source === 'string' ? long.source : undefined,
            long: true,
            type: typeof long.type === 'string' ? long.type : undefined,
          }
        : undefined;
    })
    .find(found => found !== undefined);

/** Where Chronos keeps its data: `DATA_DIR` of its environment, else the image default. */
export const chronosDataTarget = (chronos: Loose, windows: boolean): string =>
  environmentValue(chronos.environment, CHRONOS_DATA_DIR_KEY) ||
  chronosDataDir(windows);

// The mount of Core Hub is the very volume (or folder) Chronos mounts
const chronosMount = (chronos: Loose, windows: boolean): Mount | undefined =>
  mountAt(chronos.volumes, chronosDataTarget(chronos, windows), windows);

const withChronosMount = (
  volumes: unknown,
  mount: Mount,
  windows: boolean,
): ReadonlyArray<unknown> => {
  const existing = asList(volumes);
  const target = coreHubChronosDir(windows);

  if (mountAt(existing, target, windows)) {
    return existing;
  }

  return [
    ...existing,
    mount.long
      ? { type: mount.type ?? 'bind', source: mount.source, target }
      : `${mount.source}:${target}`,
  ];
};

const withoutChronosMount = (
  volumes: unknown,
  windows: boolean,
): ReadonlyArray<unknown> | undefined => {
  const target = coreHubChronosDir(windows);
  const kept = asList(volumes).filter(
    entry => mountAt([entry], target, windows) === undefined,
  );

  return kept.length === 0 ? undefined : kept;
};

// ---------------------------------------------------------------- grace period

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  h: 3600,
  m: 60,
  s: 1,
  ms: 0.001,
  us: 0.000_001,
  µs: 0.000_001,
  ns: 0.000_000_001,
};

const DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;

/** Seconds of a compose duration (`1m30s`, `90s`), or `undefined` when it is not one. */
const durationSeconds = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const parts = [...value.trim().matchAll(DURATION_PART)];

  return parts.map(part => part[0]).join('') === value.trim()
    ? parts.reduce(
        (sum, part) => sum + Number(part[1]) * UNIT_SECONDS[part[2]],
        0,
      )
    : undefined;
};

// A grace period the customer already set to at least a minute stays; one it cannot be read as stays too
const stopGracePeriod = (current: unknown): unknown => {
  if (current === undefined || current === null) {
    return STOP_GRACE_PERIOD;
  }

  const seconds = durationSeconds(current);

  return seconds !== undefined && seconds < STOP_GRACE_SECONDS
    ? STOP_GRACE_PERIOD
    : current;
};

// --------------------------------------------------------------------- checks

const hasVariablesByHand = (coreHub: Loose): boolean =>
  environmentKeys(coreHub.environment).some(key =>
    key.startsWith(VARIABLE_PREFIX),
  );

/**
 * Why the guided setup cannot be applied to this compose file. `null` when it can.
 * Reads only the compose file: the services must be there, Chronos must keep its data in a
 * volume or folder Core Hub can mount, and no `GS_DR_*` variable may be set by hand in the
 * environment of Core Hub, where it would win over the env file.
 */
export const findDisasterRecoveryBlocker: FindDisasterRecoveryBlocker = (
  compose,
  { coreHub, chronos, windows },
) => {
  const services = (compose.services ?? {}) as Loose;

  if (!services[coreHub]) {
    return `The Core Hub service "${coreHub}" is not in the compose file`;
  }

  if (!services[chronos]) {
    return `The Chronos service "${chronos}" is not in the compose file`;
  }

  const chronosService = asService(services[chronos]);
  const mount = chronosMount(chronosService, windows);

  if (!mount?.source) {
    return `Chronos does not keep its data (${chronosDataTarget(chronosService, windows)}) in a volume or folder that Core Hub can share`;
  }

  const existing = mountAt(
    asService(services[coreHub]).volumes,
    coreHubChronosDir(windows),
    windows,
  );

  if (existing && existing.source !== mount.source) {
    return `Core Hub already mounts something else at ${coreHubChronosDir(windows)}`;
  }

  return hasVariablesByHand(asService(services[coreHub]))
    ? 'GS_DR_* variables are set by hand in the environment of the Core Hub service: remove them before using the guided setup'
    : null;
};

// ---------------------------------------------------------------------- edits

const replaceService = (
  compose: Readonly<Partial<RawComposeFile>>,
  id: string,
  service: Record<string, unknown>,
): Partial<RawComposeFile> => ({
  ...compose,
  services: {
    ...compose.services,
    [id]: service,
  } as RawComposeFile['services'],
});

// A key set to `undefined` is dropped by the writer
const without = (
  service: Loose,
  changes: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries({ ...service, ...changes }).filter(
      ([, value]) => value !== undefined,
    ),
  );

/**
 * What a DR site needs in the compose file: the DR env file for Core Hub only, its sink and
 * control ports published, the data directory of Chronos mounted into it, a grace period long
 * enough for Litestream to finish, and the control URL Chronos waits on. Idempotent.
 */
export const applyDisasterRecoveryCompose: EditDisasterRecoveryCompose = (
  compose,
  targets,
) => {
  const blocker = findDisasterRecoveryBlocker(compose, targets);

  if (blocker) {
    throw new Error(blocker);
  }

  const { coreHub, chronos, windows, controlScheme } = targets;
  const services = compose.services as Loose;
  const coreHubService = asService(services[coreHub]);
  const chronosService = asService(services[chronos]);
  const mount = chronosMount(chronosService, windows) as Mount;

  const withCoreHub = replaceService(
    compose,
    coreHub,
    without(coreHubService, {
      env_file: [
        ...asList(coreHubService.env_file).filter(
          entry => !isDrEnvFileEntry(entry),
        ),
        ...drEnvFileEntries(windows),
      ],
      ports: publishedPorts(asList(coreHubService.ports)),
      volumes: withChronosMount(coreHubService.volumes, mount, windows),
      stop_grace_period: stopGracePeriod(coreHubService.stop_grace_period),
    }),
  );

  return replaceService(
    withCoreHub,
    chronos,
    without(chronosService, {
      environment: withEnvironmentValue(
        chronosService.environment,
        CONTROL_URL_KEY,
        `${controlScheme}://${coreHub}:${CONTROL_PORT}`,
      ),
    }),
  );
};

/**
 * The inverse of applyDisasterRecoveryCompose: only what the setup added goes (its env file
 * entries, the sink and control ports, the Chronos mount, a grace period of exactly the one it
 * sets, the control URL of Chronos); everything else stays. Idempotent.
 */
export const removeDisasterRecoveryCompose: EditDisasterRecoveryCompose = (
  compose,
  { coreHub, chronos, windows },
) => {
  const services = (compose.services ?? {}) as Loose;

  if (!services[coreHub] || !services[chronos]) {
    return compose;
  }

  const coreHubService = asService(services[coreHub]);
  const chronosService = asService(services[chronos]);
  const envFile = asList(coreHubService.env_file).filter(
    entry => !isDrEnvFileEntry(entry),
  );
  const ports = asList(coreHubService.ports).filter(
    entry =>
      ![SINK_PORT, CONTROL_PORT].includes(containerPort(entry) as number),
  );

  const withCoreHub = replaceService(
    compose,
    coreHub,
    without(coreHubService, {
      env_file: envFile.length === 0 ? undefined : envFile,
      ports: ports.length === 0 ? undefined : ports,
      volumes: withoutChronosMount(coreHubService.volumes, windows),
      stop_grace_period:
        coreHubService.stop_grace_period === STOP_GRACE_PERIOD
          ? undefined
          : coreHubService.stop_grace_period,
    }),
  );

  return replaceService(
    withCoreHub,
    chronos,
    without(chronosService, {
      environment: withoutEnvironmentKey(
        chronosService.environment,
        CONTROL_URL_KEY,
      ),
    }),
  );
};

// ------------------------------------------------------------------ env file

// The values end in an env file that compose reads: nothing that would need quoting is accepted
const SAFE_VALUE = /^[A-Za-z0-9._~/%+=&?,:@\\-]+$/;

const line = (key: string, value: string): string => {
  if (!SAFE_VALUE.test(value)) {
    throw new Error(`${key} has a value that cannot be written to an env file`);
  }

  // A Windows path is quoted, so that its backslashes are taken literally
  return `${key}=${value.includes('\\') ? `'${value}'` : value}`;
};

/**
 * The DR env file of a site. It holds the secrets of the pair, and the marker that tells a
 * DR set up by this Conductor from one written by hand.
 */
export const renderDisasterRecoveryEnvFile: RenderDisasterRecoveryEnvFile =
  variables =>
    `${[
      '# Written by the Gluesync Conductor disaster recovery setup. It holds secrets: keep it private.',
      '# Turn disaster recovery off with the Conductor (POST /disaster-recovery/disable), not by editing this file.',
      line(MANAGED_BY_KEY, MANAGED_BY_VALUE),
      line('GS_DR_ENABLED', 'true'),
      line('GS_DR_NODE_ID', variables.nodeId),
      line('GS_DR_PEER_URL', variables.peerUrl),
      line('GS_DR_FAILOVER_MODE', variables.failoverMode),
      ...(variables.failoverMode === 'witness' && variables.witnessUrl
        ? [
            line('GS_DR_WITNESS_URL', variables.witnessUrl),
            line('GS_DR_LEASE_TTL_SECONDS', String(variables.leaseTtlSeconds)),
          ]
        : []),
      line('GS_DR_SHARED_SECRET', variables.sharedSecret),
      line('GS_DR_ADMIN_TOKEN', variables.adminToken),
      ...(variables.pairing
        ? [
            line(PAIRING_FIRST_URL_KEY, variables.pairing.thisSiteUrl),
            line(PAIRING_JOINER_NODE_ID_KEY, variables.pairing.peerNodeId),
            line(PAIRING_LEASE_TTL_KEY, String(variables.leaseTtlSeconds)),
          ]
        : []),
      ...(variables.bootstrapActive
        ? [line('GS_DR_BOOTSTRAP_ACTIVE', 'true')]
        : []),
      line('GS_DR_CHRONOS_DIR', variables.chronosDir),
    ].join('\n')}\n`;
