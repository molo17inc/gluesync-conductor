import { upAll } from 'docker-compose';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { getDocker } from '../../utils/docker/getDocker';
import { getLogger } from '../../utils/logger';
import {
  composeFilePath,
  getBackupDir,
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
} from './healProxyErrorPages.model';
import planProxyErrorPages from './planProxyErrorPages';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

const LOG = '[proxy-error-pages]';
const BACKUP_SUBFOLDER = 'proxy-backup';

const state = new Map<string, number | Promise<unknown>>([
  ['running', 0],
  ['queue', Promise.resolve()],
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

  if (
    plan.action === 'none' ||
    (next.traefikYamlText === traefikYamlText &&
      isDeepStrictEqual(next.composeJson, compose))
  ) {
    logger[reason === 'event' ? 'debug' : 'info'](
      { reason: plan.reason, trigger: reason },
      `${LOG} nothing to change: ${plan.reason}`,
    );
    return { action: 'none', reason: plan.reason };
  }

  const backupDir = await backupFiles(traefikPath);

  logger.info(
    { action: plan.action, reason: plan.reason, trigger: reason, backupDir },
    `${LOG} ${plan.action}: ${plan.reason}; backup in ${backupDir}`,
  );

  await writeBoth(traefikPath, { traefikYamlText, composeJson: compose }, next);
  await recreateProxy(proxy);

  logger.info(
    { action: plan.action, proxy },
    `${LOG} ${plan.action} done, ${proxy} recreated`,
  );

  return { ...plan, recreated: proxy, backupDir };
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
