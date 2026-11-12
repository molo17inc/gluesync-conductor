import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { getDocker } from '../../utils/docker/getDocker';
import { getLogger } from '../../utils/logger';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import {
  commitProxyFiles,
  oneAtATime,
} from '../healProxyErrorPages/healProxyErrorPages';
import {
  findProxyServiceName,
  resolveTraefikConfPath,
} from '../healTraefikConf/healTraefikConf';
import { getDecidedOrchestrator } from '../orchestrator/getOrchestrator/getOrchestrator';
import applyCourierInboundPlan from './applyCourierInboundPlan';
import type {
  HealCourierInbound,
  HealCourierInboundOutcome,
} from './healCourierInbound.model';
import planCourierInbound from './planCourierInbound';

const LOG = '[courier-inbound]';

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

const run: HealCourierInbound = async ({ reason: trigger }) => {
  const logger = getLogger();
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
    logger.info(
      { reason: plan.reason, trigger },
      `${LOG} nothing to change: ${plan.reason}`,
    );
    return { action: 'none', reason: plan.reason };
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

  // Core Hub is never restarted for this: the running container keeps its
  // labels until it is recreated (its next update), Traefik routes then.
  if (plan.missing.includes('Core Hub labels')) {
    logger.info(
      { service: coreHub },
      `${LOG} ${coreHub} serves the courier router once it is next recreated (its next update)`,
    );
  }

  return {
    action: 'add',
    reason: plan.reason,
    missing: plan.missing,
    backupDir,
    ...(recreate && { recreated: proxy }),
  };
};

/**
 * Wires the Courier inbound port 8090 into the kit the way new kits ship it:
 * the `courier` entry point in traefik.yml, `8090:8090` on the reverse-proxy
 * and the courier router labels on Core Hub. Only the missing pieces are added;
 * an install that has them all is not touched. Compose mode only.
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
