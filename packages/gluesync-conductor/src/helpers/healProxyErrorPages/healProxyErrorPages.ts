import { upAll } from 'docker-compose';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { LabelPrefix } from '../../models/composeFile.model';
import { getDocker } from '../../utils/docker/getDocker';
import { getLogger } from '../../utils/logger';
import {
  composeFilePath,
  getBackupDir,
  refreshLastGoodFrom,
} from '../composeFile/composeBackup/composeBackup';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import { runCmd } from '../dockerode/createActions/createActions';
import safeWriteFile from '../file/safeWriteFile/safeWriteFile';
import {
  findProxyServiceName,
  resolveTraefikConfPath,
} from '../healTraefikConf/healTraefikConf';
import { getDecidedOrchestrator } from '../orchestrator/getOrchestrator/getOrchestrator';
import applyProxyErrorPagesPlan from './applyProxyErrorPagesPlan';
import type {
  HealProxyErrorPages,
  HealProxyErrorPagesOutcome,
  ProxyErrorPagesPlan,
} from './healProxyErrorPages.model';
import { targetLabels } from './errorPagesWiring';
import planProxyErrorPages, { WIRING_IN_PLACE } from './planProxyErrorPages';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

const LOG = '[proxy-error-pages]';
const BACKUP_SUBFOLDER = 'proxy-backup';

// A recreate for drift is tried once in a while, never in a loop: if the
// running proxy still lacks the labels after one, the cause is not a stale container.
const DRIFT_COOLDOWN_MS = 5 * 60_000;

const state = new Map<string, number | Promise<unknown>>([
  ['running', 0],
  ['queue', Promise.resolve()],
  ['lastDriftRecreate', 0],
]);

/** True while a run is waiting its turn or working. */
export const isHealing = (): boolean =>
  ((state.get('running') as number | undefined) ?? 0) > 0;

const skipped = (reason: string): HealProxyErrorPagesOutcome => ({
  action: 'skip',
  reason,
});

// 20261028T134501Z
const utcStamp = (now: Readonly<Date>): string =>
  now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

const backupFiles = async (traefikPath: string): Promise<string> => {
  const dir = join(
    await getBackupDir(),
    BACKUP_SUBFOLDER,
    utcStamp(new Date()),
  );

  await mkdir(dir, { recursive: true });
  await copyFile(composeFilePath(), join(dir, 'docker-compose.yml'));
  await copyFile(traefikPath, join(dir, 'traefik.yml'));

  return dir;
};

// In place: the proxy mounts traefik.yml as a file of its own, which keeps the
// inode it was mounted with. certs.yml is never opened.
const writeTraefik = (path: string, text: string): Promise<void> =>
  safeWriteFile(path, text, { mode: 'in-place' });

// Only the file that changes is written. The static file goes first and is put
// back when the compose file then fails: never one ahead of the other.
const writeBoth = async (
  traefikPath: string,
  before: Readonly<{
    traefikYamlText: string;
    composeJson: Record<string, any>;
  }>,
  after: Readonly<{
    traefikYamlText: string;
    composeJson: Record<string, any>;
  }>,
): Promise<void> => {
  const staticChanged = after.traefikYamlText !== before.traefikYamlText;

  if (staticChanged) {
    await writeTraefik(traefikPath, after.traefikYamlText);
  }

  if (isDeepStrictEqual(after.composeJson, before.composeJson)) {
    return;
  }

  try {
    await writeComposeFile(after.composeJson);
  } catch (error) {
    if (staticChanged) {
      await writeTraefik(traefikPath, before.traefikYamlText).catch(
        () => undefined,
      );
    }
    throw error;
  }
};

const recreateProxy = async (proxy: string): Promise<void> => {
  await runCmd(upAll, proxy, dkrComposeFile, ['--no-deps', '--force-recreate']);
};

// Writes the files back as they were before the heal: traefik.yml in place,
// the compose file byte for byte from the backup (writeComposeFile merges into
// the parsed document and may still reformat). The last-good copy follows.
const restoreFiles = async (
  traefikPath: string,
  before: Readonly<{
    traefikYamlText: string;
    composeJson: Record<string, any>;
  }>,
  after: Readonly<{
    traefikYamlText: string;
    composeJson: Record<string, any>;
  }>,
  backupDir: string,
): Promise<void> => {
  if (after.traefikYamlText !== before.traefikYamlText) {
    await writeTraefik(traefikPath, before.traefikYamlText);
  }

  if (!isDeepStrictEqual(after.composeJson, before.composeJson)) {
    await safeWriteFile(
      composeFilePath(),
      await readFile(join(backupDir, 'docker-compose.yml')),
    );
    await refreshLastGoodFrom(composeFilePath());
  }
};

// The files are put back, then the proxy is recreated once more so the running
// container matches them: left with the new traefik.yml and an old container, a
// plain restart would load a middleware that no container defines (404 on every route).
const rollBack = async (
  proxy: string,
  traefikPath: string,
  before: Readonly<{
    traefikYamlText: string;
    composeJson: Record<string, any>;
  }>,
  after: Readonly<{
    traefikYamlText: string;
    composeJson: Record<string, any>;
  }>,
  backupDir: string,
  error: unknown,
): Promise<void> => {
  const logger = getLogger();

  logger.error({ error }, `${LOG} recreating ${proxy} failed`);
  await restoreFiles(traefikPath, before, after, backupDir);
  logger.error(
    { backupDir, proxy },
    `${LOG} recreate failed, files restored from ${backupDir}`,
  );

  try {
    await recreateProxy(proxy);
  } catch (error_) {
    logger.error(
      { error: error_ },
      `${LOG} recreating ${proxy} with the restored files failed too; the files are as before the heal, a plain restart is safe`,
    );
  }
};

/** Labels of the running reverse-proxy container; undefined when it cannot be read. */
const runningLabels = async (
  proxy: string,
): Promise<Readonly<Record<string, string>> | undefined> => {
  try {
    const [container] = await getDocker().listContainers({
      filters: {
        label: [`${LabelPrefix.COMPOSE}.service=${proxy}`],
        status: ['running'],
      },
    });

    return container?.Labels;
  } catch {
    return undefined;
  }
};

const lacksTargetLabels = (
  labels: Readonly<Record<string, string>>,
  isWindows: boolean,
): boolean =>
  Object.entries(targetLabels(isWindows)).some(
    ([key, value]) => labels[key] !== value,
  );

// The files carry the whole wiring; the container, created before them, may not.
const healDrift = async (
  proxy: string,
  isWindows: boolean,
  trigger: string,
): Promise<HealProxyErrorPagesOutcome> => {
  const logger = getLogger();
  const labels = await runningLabels(proxy);
  const lastAt = (state.get('lastDriftRecreate') as number) ?? 0;

  if (!labels || !lacksTargetLabels(labels, isWindows)) {
    return { action: 'none', reason: WIRING_IN_PLACE };
  }

  if (Date.now() - lastAt < DRIFT_COOLDOWN_MS) {
    logger.warn(
      { trigger },
      `${LOG} running ${proxy} still lacks the wiring after a recreate, not trying again yet`,
    );
    return { action: 'none', reason: WIRING_IN_PLACE };
  }

  state.set('lastDriftRecreate', Date.now());
  logger.info(
    { trigger, proxy },
    `${LOG} recreate: running ${proxy} does not have the wiring of the compose file`,
  );
  await recreateProxy(proxy);
  logger.info({ proxy }, `${LOG} recreate done, ${proxy} recreated`);

  return {
    action: 'recreate',
    reason: 'running proxy does not have the wiring of the compose file',
    recreated: proxy,
  };
};

type Files = Readonly<{
  traefikYamlText: string;
  composeJson: Record<string, any>;
}>;

const logNothingToChange = (trigger: string, reason: string): void => {
  getLogger()[trigger === 'event' ? 'debug' : 'info'](
    { reason, trigger },
    `${LOG} nothing to change: ${reason}`,
  );
};

// Backs up, writes both files and recreates the proxy; a failed recreate puts
// the files back (see rollBack).
const applyAndRecreate = async ({
  plan,
  proxy,
  traefikPath,
  trigger,
  before,
  next,
}: Readonly<{
  plan: ProxyErrorPagesPlan;
  proxy: string;
  traefikPath: string;
  trigger: string;
  before: Files;
  next: Files;
}>): Promise<HealProxyErrorPagesOutcome> => {
  const logger = getLogger();
  const backupDir = await backupFiles(traefikPath);

  logger.info(
    { action: plan.action, reason: plan.reason, trigger, backupDir },
    `${LOG} ${plan.action}: ${plan.reason}; backup in ${backupDir}`,
  );

  await writeBoth(traefikPath, before, next);

  try {
    await recreateProxy(proxy);
  } catch (error) {
    await rollBack(proxy, traefikPath, before, next, backupDir, error);
    return skipped('recreate failed, files restored');
  }

  logger.info(
    { action: plan.action, proxy },
    `${LOG} ${plan.action} done, ${proxy} recreated`,
  );

  return { ...plan, recreated: proxy, backupDir };
};

const run: HealProxyErrorPages = async ({ reason }) => {
  const logger = getLogger();
  const orchestrator = await getDecidedOrchestrator(getDocker());

  if (orchestrator?.mode !== 'compose') {
    return skipped(
      orchestrator ? 'not compose mode' : 'Docker mode not known yet',
    );
  }

  const compose = await readComposeFile({ raw: true });
  const proxy = findProxyServiceName(compose);

  if (!proxy) {
    return skipped('no reverse-proxy service');
  }

  const traefikPath = resolveTraefikConfPath(compose.services?.[proxy]);

  if (!traefikPath) {
    return skipped('traefik.yml not found');
  }

  const traefikYamlText = await readFile(traefikPath, 'utf8');
  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';
  const plan = planProxyErrorPages({
    composeJson: compose,
    proxyServiceName: proxy,
    traefikYamlText,
    isWindows,
  });

  if (plan.action === 'skip') {
    logger.warn(
      { reason: plan.reason, trigger: reason },
      `${LOG} left as it is: ${plan.reason}`,
    );
    return plan;
  }

  const next = applyProxyErrorPagesPlan(
    { composeJson: compose, traefikYamlText },
    plan,
    proxy,
    isWindows,
  );

  if (plan.action === 'none' && plan.reason === WIRING_IN_PLACE) {
    const drift = await healDrift(proxy, isWindows, reason);

    if (drift.action === 'none') {
      logNothingToChange(reason, plan.reason);
    }

    return drift;
  }

  if (
    plan.action === 'none' ||
    (next.traefikYamlText === traefikYamlText &&
      isDeepStrictEqual(next.composeJson, compose))
  ) {
    logNothingToChange(reason, plan.reason);
    return { action: 'none', reason: plan.reason };
  }

  return applyAndRecreate({
    plan,
    proxy,
    traefikPath,
    trigger: reason,
    before: { traefikYamlText, composeJson: compose },
    next,
  });
};

/**
 * Brings the MOLO17 error pages wiring of the kit in line with the
 * reverse-proxy image: added when the image can serve it, removed when it
 * cannot (or the customer opted out). v0.0.286 wiring stays while the image
 * still serves it. Compose mode only.
 * Runs one at a time and never throws: a failure is logged and the caller goes on.
 */
const healProxyErrorPages: HealProxyErrorPages = options => {
  state.set('running', ((state.get('running') as number) ?? 0) + 1);

  const queued = (state.get('queue') as Promise<unknown>).then(async () => {
    try {
      return await run(options);
    } catch (error) {
      getLogger().error(
        { error, trigger: options.reason },
        `${LOG} failed, nothing more is changed`,
      );
      return skipped('failed');
    } finally {
      state.set('running', (state.get('running') as number) - 1);
    }
  });

  state.set('queue', queued);

  return queued;
};

export default healProxyErrorPages;
