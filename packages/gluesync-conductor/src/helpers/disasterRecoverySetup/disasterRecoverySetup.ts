import { upAll } from 'docker-compose';
import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { getDocker } from '../../utils/docker/getDocker';
import { getLogger } from '../../utils/logger';
import {
  composeFilePath,
  getBackupDir,
  getKitFolder,
  refreshLastGoodFrom,
} from '../composeFile/composeBackup/composeBackup';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import { runCmd } from '../dockerode/createActions/createActions';
import safeWriteFile from '../file/safeWriteFile/safeWriteFile';
import { getDecidedOrchestrator } from '../orchestrator/getOrchestrator/getOrchestrator';
import giveChronosDataToCoreHub from '../disasterRecoveryOwnership/disasterRecoveryOwnership';
import parseEnvFile from '../swarm/parseEnvFile/parseEnvFile';
import verifyServiceStable from '../verifyServiceStable/verifyServiceStable';
import {
  chronosName,
  coreHubName,
  declaredValue,
  isDisasterRecoveryEnabled,
} from '../disasterRecovery/disasterRecovery';
import {
  DR_ENV_FILE_NAME,
  MANAGED_BY_KEY,
  MANAGED_BY_VALUE,
  applyDisasterRecoveryCompose,
  coreHubChronosDir,
  findDisasterRecoveryBlocker,
  removeDisasterRecoveryCompose,
  renderDisasterRecoveryEnvFile,
} from '../disasterRecoveryCompose/disasterRecoveryCompose';
import type { DisasterRecoveryTargets } from '../disasterRecoveryCompose/disasterRecoveryCompose.model';
import type {
  DisasterRecoveryState,
  InspectDisasterRecovery,
  PrepareDisasterRecoveryChange,
  ReadDisasterRecoveryEnv,
} from './disasterRecoverySetup.model';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

const LOG = '[disaster-recovery]';
const BACKUP_SUBFOLDER = 'dr-backup';

const SWARM_REASON =
  'Docker Swarm: the Conductor does not edit the stack file. Set the GS_DR_* variables on the Core Hub service of the stack by hand';

const NOT_DECIDED_REASON =
  'Cannot tell whether Gluesync runs on Docker Compose or Docker Swarm: the Docker daemon is not answering';

const NO_DETAILS = {
  nodeId: null,
  peerUrl: null,
  failoverMode: null,
  witnessUrl: null,
  bootstrapActive: false,
} as const;

export const getDisasterRecoveryTargets = async (
  compose: Readonly<Parameters<typeof findDisasterRecoveryBlocker>[0]>,
): Promise<DisasterRecoveryTargets> => {
  const coreHub = compose.services?.[coreHubName()];
  const ssl = coreHub ? await declaredValue(coreHub, 'SSL_ENABLED') : '';

  return {
    coreHub: coreHubName(),
    chronos: chronosName(),
    windows: process.env.IS_WINDOWS?.toLowerCase() === 'true',
    // Core Hub serves the control port over TLS when it runs with SSL
    controlScheme: ssl.trim().toLowerCase() === 'true' ? 'https' : 'http',
  };
};

const orEmpty = (value: string): string | null => value.trim() || null;

const readDetails = async (
  coreHub: Parameters<typeof declaredValue>[0],
): Promise<
  Pick<
    DisasterRecoveryState,
    | 'nodeId'
    | 'peerUrl'
    | 'failoverMode'
    | 'witnessUrl'
    | 'bootstrapActive'
    | 'managedByConductor'
  >
> => {
  const [nodeId, peerUrl, mode, witnessUrl, bootstrap, managedBy] =
    await Promise.all(
      [
        'GS_DR_NODE_ID',
        'GS_DR_PEER_URL',
        'GS_DR_FAILOVER_MODE',
        'GS_DR_WITNESS_URL',
        'GS_DR_BOOTSTRAP_ACTIVE',
        MANAGED_BY_KEY,
      ].map(key => declaredValue(coreHub, key)),
    );

  return {
    nodeId: orEmpty(nodeId),
    peerUrl: orEmpty(peerUrl),
    failoverMode:
      mode.trim().toLowerCase() === 'witness' ? 'witness' : 'manual',
    witnessUrl: orEmpty(witnessUrl),
    bootstrapActive: bootstrap.trim().toLowerCase() === 'true',
    managedByConductor: managedBy.trim() === MANAGED_BY_VALUE,
  };
};

/**
 * What the Conductor knows about disaster recovery on this host, read from the compose
 * file alone (a standby Core Hub does not answer HTTP). Secrets are never part of it.
 */
export const inspectDisasterRecovery: InspectDisasterRecovery =
  async docker => {
    const orchestrator = await getDecidedOrchestrator(docker);
    const compose = orchestrator
      ? await readComposeFile({ raw: true })
      : undefined;
    const targets = await getDisasterRecoveryTargets(compose ?? {});
    const unsupported = (
      reason: string,
      state: Partial<DisasterRecoveryState> = {},
    ) => ({
      state: {
        supported: false,
        reason,
        enabled: false,
        managedByConductor: false,
        ...NO_DETAILS,
        ...state,
      },
      dockerUnknown: !orchestrator,
      mode: orchestrator?.mode,
      targets,
      compose,
    });

    if (!orchestrator || !compose) {
      return unsupported(NOT_DECIDED_REASON);
    }

    const enabled = await isDisasterRecoveryEnabled(compose);
    const details =
      enabled && compose.services?.[targets.coreHub]
        ? await readDetails(compose.services[targets.coreHub])
        : { ...NO_DETAILS, managedByConductor: false };
    const blocker =
      orchestrator.mode === 'swarm'
        ? SWARM_REASON
        : findDisasterRecoveryBlocker(compose, targets);

    return {
      state: {
        supported: blocker === null,
        reason: blocker,
        enabled,
        ...details,
      },
      dockerUnknown: false,
      mode: orchestrator.mode,
      targets,
      compose,
    };
  };

// ------------------------------------------------------------------ the files

const envFilePath = async (): Promise<string> =>
  join(await getKitFolder(), DR_ENV_FILE_NAME);

/**
 * The variables of the DR env file of this site, secrets included: for the caller that
 * shows the pairing code again and nothing else. `undefined` when the file is not there.
 */
export const readDisasterRecoveryEnv: ReadDisasterRecoveryEnv = async () => {
  try {
    return parseEnvFile(await readFile(await envFilePath(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

// 2026-11-06 -> 20261106T134501Z
const utcStamp = (now: Readonly<Date>): string =>
  now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

type Backup = Readonly<{
  dir: string;
  compose: string;
  envFile: string;
  hadEnvFile: boolean;
}>;

const exists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

// The env file holds secrets: its copy is private too
const privately = async (path: string): Promise<void> => {
  try {
    await chmod(path, 0o600);
  } catch {
    // not possible on every platform (Windows)
  }
};

const backupFiles = async (envFile: string): Promise<Backup> => {
  const dir = join(
    await getBackupDir(),
    BACKUP_SUBFOLDER,
    utcStamp(new Date()),
  );
  const backup: Backup = {
    dir,
    compose: join(dir, 'docker-compose.yml'),
    envFile: join(dir, DR_ENV_FILE_NAME),
    hadEnvFile: await exists(envFile),
  };

  await mkdir(dir, { recursive: true });
  await copyFile(composeFilePath(), backup.compose);

  if (backup.hadEnvFile) {
    await copyFile(envFile, backup.envFile);
    await privately(backup.envFile);
  }

  return backup;
};

// The compose file byte for byte from the backup (writeComposeFile merges into the parsed
// document and may still reformat), the env file as it was or not there; the last-good copy follows
const restoreFiles = async (envFile: string, backup: Backup): Promise<void> => {
  await safeWriteFile(composeFilePath(), await readFile(backup.compose));
  await refreshLastGoodFrom(composeFilePath());

  if (backup.hadEnvFile) {
    await safeWriteFile(envFile, await readFile(backup.envFile));
    await privately(envFile);
  } else {
    await rm(envFile, { force: true });
  }
};

// ----------------------------------------------------------------- the change

const recreateService = async (id: string): Promise<void> => {
  await runCmd(upAll, id, dkrComposeFile, ['--no-deps', '--force-recreate']);
};

// Chronos first: with its guard in place it waits for the Core Hub that comes next
const recreateBoth = async ({
  coreHub,
  chronos,
}: DisasterRecoveryTargets): Promise<void> => {
  await recreateService(chronos);
  await recreateService(coreHub);
};

// "up" succeeds as soon as the container is created, even when Core Hub then refuses its settings
const recreateAndVerify = async (
  targets: DisasterRecoveryTargets,
): Promise<void> => {
  await recreateBoth(targets);
  await verifyServiceStable(getDocker(), targets.coreHub);
};

const rollBack = async (
  targets: DisasterRecoveryTargets,
  envFile: string,
  backup: Backup,
  error: unknown,
): Promise<void> => {
  const logger = getLogger();

  logger.error({ error }, `${LOG} recreating the services failed`);
  await restoreFiles(envFile, backup);
  logger.error(
    { backupDir: backup.dir },
    `${LOG} files restored from ${backup.dir}, recreating the services once more`,
  );

  try {
    await recreateBoth(targets);
  } catch (error_) {
    logger.error(
      { error: error_ },
      `${LOG} recreating the services with the restored files failed too; the files are as before the change, a plain restart is safe`,
    );
  }
};

const nextCompose = (
  change: Parameters<PrepareDisasterRecoveryChange>[0],
  compose: Readonly<Parameters<typeof applyDisasterRecoveryCompose>[0]>,
  targets: DisasterRecoveryTargets,
) =>
  change.kind === 'enable'
    ? applyDisasterRecoveryCompose(compose, targets)
    : removeDisasterRecoveryCompose(compose, targets);

// Disable removes the file; its backup holds the secrets of a pair that no longer exists
const dropSecretsBackup = async (backup: Backup): Promise<void> => {
  await rm(backup.envFile, { force: true });
};

/**
 * Backs up the compose file and the DR env file, then writes the new ones. A write that
 * fails puts both back. The services are only recreated by `recreate`, so that a caller
 * can answer its request first.
 */
export const prepareDisasterRecoveryChange: PrepareDisasterRecoveryChange =
  async (change, targets) => {
    const logger = getLogger();
    const compose = await readComposeFile({ raw: true });
    const next = nextCompose(change, compose, targets);
    const envFile = await envFilePath();
    const backup = await backupFiles(envFile);

    logger.info(
      { action: change.kind, backupDir: backup.dir },
      `${LOG} ${change.kind}: compose and env file backed up to ${backup.dir}`,
    );

    try {
      if (change.kind === 'enable') {
        // Core Hub writes in the data directory of Chronos; a failure is a failed setup
        await giveChronosDataToCoreHub(getDocker(), compose, targets);
        await safeWriteFile(
          envFile,
          renderDisasterRecoveryEnvFile({
            ...change.variables,
            chronosDir: coreHubChronosDir(targets.windows),
          }),
        );
        await privately(envFile);
      }

      await writeComposeFile(next);

      if (change.kind === 'disable') {
        await rm(envFile, { force: true });
      }
    } catch (error) {
      logger.error(
        { error },
        `${LOG} writing the files failed, restoring them`,
      );
      await restoreFiles(envFile, backup);
      throw error;
    }

    return {
      restarting: [targets.coreHub, targets.chronos],
      recreate: async () => {
        logger.info(
          { action: change.kind },
          `${LOG} ${change.kind}: recreating ${targets.chronos} and ${targets.coreHub}`,
        );

        try {
          await recreateAndVerify(targets);
        } catch (error) {
          await rollBack(targets, envFile, backup, error);
          throw error;
        }

        if (change.kind === 'disable') {
          await dropSecretsBackup(backup);
        }

        logger.info(
          { action: change.kind },
          `${LOG} ${change.kind} done, ${targets.chronos} and ${targets.coreHub} recreated`,
        );
      },
    };
  };
