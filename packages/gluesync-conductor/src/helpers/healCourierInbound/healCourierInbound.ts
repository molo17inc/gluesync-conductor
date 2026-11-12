import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { getDocker } from '../../utils/docker/getDocker';
import { getLogger } from '../../utils/logger';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import {
  labelMap,
  labelsOf,
} from '../healProxyErrorPages/composeLabelTransforms';
import {
  commitProxyFiles,
  oneAtATime,
  recreateService,
  runningServiceLabels,
} from '../healProxyErrorPages/healProxyErrorPages';
import {
  findProxyServiceName,
  resolveTraefikConfPath,
} from '../healTraefikConf/healTraefikConf';
import { getDecidedOrchestrator } from '../orchestrator/getOrchestrator/getOrchestrator';
import applyCourierInboundPlan from './applyCourierInboundPlan';
import { COURIER_LABELS } from './courierInboundWiring';
import type {
  CoreHubRecreate,
  HealCourierInbound,
  HealCourierInboundOutcome,
} from './healCourierInbound.model';
import planCourierInbound, { WIRING_IN_PLACE } from './planCourierInbound';

const LOG = '[courier-inbound]';

// A Core Hub recreate is tried once in a while, never in a loop: if the running
// container still lacks the labels after one, the cause is not a stale container.
const COREHUB_COOLDOWN_MS = 5 * 60_000;

const state = new Map<string, number>([['lastCoreHubRecreate', 0]]);

const hasCourierLabels = (labels: Readonly<Record<string, string>>): boolean =>
  Object.entries(COURIER_LABELS).every(([key, value]) => labels[key] === value);

const recreateCoreHub = async (
  coreHub: string,
  trigger: string,
): Promise<CoreHubRecreate> => {
  const logger = getLogger();

  state.set('lastCoreHubRecreate', Date.now());
  logger.info(
    { service: coreHub, trigger },
    `${LOG} recreating ${coreHub} to apply the courier route labels`,
  );

  // Once more after a failure, so a recreate that died half way does not leave
  // it stopped. The files stay: the labels are not what makes a recreate fail.
  const attempt = async (failure: string): Promise<boolean> => {
    try {
      await recreateService(coreHub);
      return true;
    } catch (error) {
      logger.error({ error }, `${LOG} ${failure}`);
      return false;
    }
  };

  const done =
    (await attempt(`recreating ${coreHub} failed`)) ||
    (await attempt(
      `recreating ${coreHub} failed again; start it with docker compose up -d ${coreHub}`,
    ));

  if (!done) {
    return 'failed';
  }

  logger.info(
    { service: coreHub },
    `${LOG} ${coreHub} recreated, the courier route labels are applied`,
  );

  return 'recreated';
};

/**
 * The compose file gives Core Hub the courier labels and its running container
 * does not have them (created before they were written): Core Hub is
 * recreated, once per cooldown. A Core Hub that is not running, or cannot be
 * inspected, is left alone. Undefined when there is nothing to do.
 */
const syncCoreHub = async (
  coreHub: string,
  composeJson: Readonly<Record<string, any>>,
  trigger: string,
): Promise<CoreHubRecreate | undefined> => {
  if (!hasCourierLabels(labelMap(labelsOf(composeJson.services?.[coreHub])))) {
    return undefined;
  }

  const running = await runningServiceLabels(coreHub);

  if (!running || hasCourierLabels(running)) {
    return undefined;
  }

  const lastAt = state.get('lastCoreHubRecreate') ?? 0;

  if (Date.now() - lastAt < COREHUB_COOLDOWN_MS) {
    getLogger().warn(
      { service: coreHub, trigger },
      `${LOG} running ${coreHub} still lacks the courier route labels after a recreate, not trying again yet`,
    );
    return 'cooldown';
  }

  return recreateCoreHub(coreHub, trigger);
};

const skipped = (reason: string): HealCourierInboundOutcome => ({
  action: 'skip',
  reason,
});

// `info` for an install this heal is not meant for (no kit proxy, not compose),
// `warn` for a kit it leaves alone on purpose
const leftAlone = (
  trigger: string,
  reason: string,
  level: 'info' | 'warn' = 'warn',
): HealCourierInboundOutcome => {
  getLogger()[level]({ reason, trigger }, `${LOG} left as it is: ${reason}`);
  return skipped(reason);
};

// Nothing to add to the files. Opted out: never recreate. Wired: the running
// Core Hub may still be older than them.
const nothingToAdd = async (
  reason: string,
  coreHub: string,
  compose: Readonly<Record<string, any>>,
  trigger: string,
): Promise<HealCourierInboundOutcome> => {
  const coreHubOutcome =
    reason === WIRING_IN_PLACE
      ? await syncCoreHub(coreHub, compose, trigger)
      : undefined;

  if (!coreHubOutcome) {
    getLogger().info(
      { reason, trigger },
      `${LOG} nothing to change: ${reason}`,
    );
  }

  return {
    action: 'none',
    reason,
    ...(coreHubOutcome && { coreHub: coreHubOutcome }),
  };
};

const run: HealCourierInbound = async ({ reason: trigger }) => {
  const orchestrator = await getDecidedOrchestrator(getDocker());

  if (orchestrator?.mode !== 'compose') {
    return leftAlone(
      trigger,
      orchestrator ? 'not compose mode' : 'Docker mode not known yet',
      'info',
    );
  }

  const compose = await readComposeFile({ raw: true });
  const proxy = findProxyServiceName(compose);

  if (!proxy) {
    return leftAlone(trigger, 'no reverse-proxy service', 'info');
  }

  const traefikPath = resolveTraefikConfPath(compose.services?.[proxy]);

  if (!traefikPath) {
    return leftAlone(trigger, 'traefik.yml not found', 'info');
  }

  const coreHub = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
  const traefikYamlText = await readFile(traefikPath, 'utf8');
  const plan = planCourierInbound({
    composeJson: compose,
    proxyServiceName: proxy,
    coreHubServiceName: coreHub,
    traefikYamlText,
  });

  if (plan.action === 'skip') {
    return leftAlone(trigger, plan.reason);
  }

  if (plan.action === 'none') {
    return nothingToAdd(plan.reason, coreHub, compose, trigger);
  }

  const applied = applyCourierInboundPlan(
    { composeJson: compose, traefikYamlText },
    plan,
    proxy,
    coreHub,
  );

  if (!applied.ok) {
    return leftAlone(trigger, applied.reason);
  }

  const next = applied.files as Readonly<{
    traefikYamlText: string;
    composeJson: Record<string, any>;
  }>;
  // Traefik reads its entry points and Docker its published ports only when
  // the proxy is created. Labels of Core Hub alone need no proxy recreate.
  const recreate =
    next.traefikYamlText !== traefikYamlText ||
    !isDeepStrictEqual(
      next.composeJson.services?.[proxy],
      compose.services?.[proxy],
    );

  const { backupDir, restored } = await commitProxyFiles({
    log: LOG,
    action: plan.action,
    reason: plan.reason,
    trigger,
    proxy,
    traefikPath,
    before: { traefikYamlText, composeJson: compose },
    next,
    recreate,
  });

  if (restored) {
    return skipped('recreate failed, files restored');
  }

  // Only now, with both files written and the proxy recreated: a run that
  // failed or was rolled back never gets here
  const coreHubOutcome = await syncCoreHub(coreHub, next.composeJson, trigger);

  return {
    action: 'add',
    reason: plan.reason,
    missing: plan.missing,
    backupDir,
    ...(recreate && { recreated: proxy }),
    ...(coreHubOutcome && { coreHub: coreHubOutcome }),
  };
};

/**
 * Wires the Courier inbound port 8090 into the kit the way new kits ship it:
 * the `courier` entry point in traefik.yml, `8090:8090` on the reverse-proxy
 * and the courier router labels on Core Hub. Only the missing pieces are added;
 * an install that has them all is not touched. The proxy is recreated when its
 * files change, Core Hub when its running container lacks the courier labels
 * the compose file gives it (once per install, then only after a drift).
 * Compose mode only.
 * Runs one at a time with the error pages heal and never throws: a failure is
 * logged and the caller goes on.
 */
const healCourierInbound: HealCourierInbound = options =>
  oneAtATime(
    () => run(options),
    error => {
      getLogger().error(
        { error, trigger: options.reason },
        `${LOG} failed, nothing more is changed`,
      );
      return skipped('failed');
    },
  );

export default healCourierInbound;
