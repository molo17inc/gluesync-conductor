import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import extractKeyValue from '../composeFile/extractKeyValue/extractKeyValue';
import getRootPath from '../getRootPath/getRootPath';
import parseEnvFile from '../swarm/parseEnvFile/parseEnvFile';
import { getLogger } from '../../utils/logger';
import {
  GetDisasterRecoveryUpdateBlock,
  GetDisasterRecoveryUpdateRefusal,
  IsDisasterRecoveryEnabled,
  DisasterRecoveryService,
} from './disasterRecovery.model';

const DR_ENV_KEY = 'GS_DR_ENABLED';

const DR_DOCS_URL = 'https://docs.molo17.com/gluesync/latest/';

const DR_GUIDANCE = `the sites one at a time with Gluesync Control, standby first, then a planned switchover. See ${DR_DOCS_URL} (upgrade a disaster-recovery pair).`;

export const DR_UPDATE_REFUSED_ERROR =
  'Disaster recovery is enabled on this Core Hub';

export const DR_UPDATE_REFUSED_DETAILS = `Update ${DR_GUIDANCE}`;

export const DR_UPDATE_BLOCKED_REASON = `${DR_UPDATE_REFUSED_ERROR}: update ${DR_GUIDANCE}`;

type Variables = Readonly<Record<string, string>>;

// `$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR-default}`; `$$` is a literal `$`
const REFERENCE =
  /\$(?:\$|([A-Za-z_]\w*)|\{([A-Za-z_]\w*)(?:(:?)-([^}]*))?\})/g;

const interpolate = (value: string, variables: Variables): string =>
  value.replace(
    REFERENCE,
    (
      match: string,
      bare?: string,
      braced?: string,
      colon?: string,
      fallback?: string,
    ) => {
      if (match === '$$') {
        return '$';
      }

      const found = variables[bare ?? braced ?? ''];
      const missing = found === undefined || (colon === ':' && found === '');

      return missing ? (fallback ?? '') : found;
    },
  );

// A file that is not there (or cannot be read) contributes nothing: compose
// treats an optional env_file the same way
const readVariables = async (file: string): Promise<Variables> => {
  try {
    return parseEnvFile(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger().warn(
        { file, error },
        '[disaster-recovery] could not read an env file',
      );
    }

    return {};
  }
};

const envFilePaths = (
  envFile: Readonly<DisasterRecoveryService['env_file']>,
): ReadonlyArray<string> =>
  (Array.isArray(envFile) ? envFile : [envFile])
    .map(entry =>
      typeof entry === 'string'
        ? entry
        : ((entry as { path?: string } | undefined)?.path ?? ''),
    )
    .map(path => path.trim())
    .filter(Boolean)
    .map(path => (isAbsolute(path) ? path : getRootPath({ filename: path })));

// Compose reads `.env` of the project directory to interpolate the file
const projectVariables = (): Promise<Variables> =>
  readVariables(getRootPath({ filename: '.env' }));

// `GS_DR_ENABLED` alone (no value) takes the value from the project `.env`
const withPassThrough = (
  environment: DisasterRecoveryService['environment'],
): DisasterRecoveryService['environment'] =>
  Array.isArray(environment)
    ? environment.map(entry =>
        typeof entry === 'string' && entry.trim() === DR_ENV_KEY
          ? `${DR_ENV_KEY}=\${${DR_ENV_KEY}}`
          : entry,
      )
    : environment;

const declaredValue = async (
  service: Readonly<DisasterRecoveryService>,
): Promise<string> => {
  const fromFiles = (
    await Promise.all(envFilePaths(service.env_file).map(readVariables))
  ).reduce<Variables>((acc, variables) => ({ ...acc, ...variables }), {});

  const fromEnvironment = extractKeyValue(
    '=',
    withPassThrough(service.environment) as Parameters<
      typeof extractKeyValue
    >[1],
  );

  // `environment` wins over `env_file`, like compose does
  const raw =
    DR_ENV_KEY in fromEnvironment
      ? (fromEnvironment[DR_ENV_KEY] ?? `\${${DR_ENV_KEY}}`)
      : fromFiles[DR_ENV_KEY];
  const text = String(raw ?? '');

  return text.includes('$')
    ? interpolate(text, await projectVariables())
    : text;
};

const coreHubName = (): string =>
  process.env.CORE_HUB_NAME || 'gluesync-core-hub';

const chronosName = (): string =>
  process.env.CHRONOS_NAME || 'gluesync-chronos';

export const isDisasterRecoveryEnabled: IsDisasterRecoveryEnabled =
  async composeJson => {
    const coreHub = composeJson.services?.[coreHubName()];

    if (!coreHub) {
      return false;
    }

    return (await declaredValue(coreHub)).trim().toLowerCase() === 'true';
  };

// Chronos is replicated with Core Hub, so it follows it
const isGuarded = (serviceId: string): boolean =>
  serviceId === coreHubName() || serviceId === chronosName();

export const getDisasterRecoveryUpdateBlock: GetDisasterRecoveryUpdateBlock =
  async (composeJson, serviceId) =>
    isGuarded(serviceId) && (await isDisasterRecoveryEnabled(composeJson))
      ? { updateBlocked: true, reason: DR_UPDATE_BLOCKED_REASON }
      : { updateBlocked: false };

export const getDisasterRecoveryUpdateRefusal: GetDisasterRecoveryUpdateRefusal =
  async (composeJson, requestIds) =>
    (requestIds.length === 0 || requestIds.some(isGuarded)) &&
    (await isDisasterRecoveryEnabled(composeJson))
      ? DR_UPDATE_BLOCKED_REASON
      : null;
