import type Docker from 'dockerode';

import { getLogger } from '../../../utils/logger';
import getService from '../getService/getService';
import getServiceTasks from '../getServiceTasks/getServiceTasks';
import { SwarmService, SwarmTask } from '../swarm.model';
import {
  ConvergeResult,
  WaitForServiceConverged,
} from './waitForServiceConverged.model';

// Swarm gave up on the new version, or went back to the old one
const FAILED_UPDATE_STATES: ReadonlySet<string> = new Set([
  'rollback_started',
  'rollback_completed',
  'rollback_paused',
  'paused',
]);

const sleepMs = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const envMs = (name: string, fallbackSeconds: number): number => {
  const raw = Number(process.env[name]);
  return (Number.isFinite(raw) && raw >= 0 ? raw : fallbackSeconds) * 1000;
};

const isNotFound = (error: unknown): boolean =>
  (error as { statusCode?: number })?.statusCode === 404;

type Observation =
  | Readonly<{
      kind: 'seen';
      service: SwarmService;
      tasks: ReadonlyArray<SwarmTask>;
    }>
  | Readonly<{ kind: 'error'; error: unknown }>;

type Verdict =
  | Readonly<{ kind: 'converged' }>
  | Readonly<{ kind: 'pending'; detail: string }>
  | Readonly<{ kind: 'failed'; reason: string }>;

const judge = (
  fullName: string,
  service: SwarmService,
  tasks: ReadonlyArray<SwarmTask>,
): Verdict => {
  const state = service.updateState;

  if (state && FAILED_UPDATE_STATES.has(state)) {
    const message = service.updateMessage ? `: ${service.updateMessage}` : '';

    return {
      kind: 'failed',
      reason: `${fullName} update ${state}${message}`,
    };
  }

  const running = tasks.filter(task => task.state === 'running').length;
  // A global service runs wherever it is scheduled: every task must be up
  const expected = service.replicas ?? tasks.length;
  const forceUpdate = service.spec.TaskTemplate?.ForceUpdate ?? 0;
  // Right after an update call the status is still empty and the old tasks
  // still run: they do not count
  const onCurrentSpec = tasks.every(
    task => task.image === service.image && task.forceUpdate === forceUpdate,
  );
  const detail = `update ${state ?? 'none'}, ${running}/${expected} tasks running`;

  return (!state || state === 'completed') &&
    onCurrentSpec &&
    running === expected &&
    tasks.length === expected &&
    (service.replicas !== undefined || expected > 0)
    ? { kind: 'converged' }
    : { kind: 'pending', detail };
};

// Failed tasks are replaced and no longer "should run", so ask for them to say why
const latestFailure = async (
  docker: Readonly<Docker>,
  fullName: string,
): Promise<string> => {
  try {
    const failed = (
      await getServiceTasks(docker, fullName, {
        includeStopped: true,
        resolveNodes: false,
      })
    ).find(task => task.err ?? ['failed', 'rejected'].includes(task.state));

    return failed
      ? ` (last task ${failed.state}: ${failed.err ?? failed.message ?? 'no message'})`
      : '';
  } catch {
    return '';
  }
};

/**
 * "Converged" (docs/swarm-mode.md): the update status is `completed` or empty,
 * as many tasks run as the service wants, they come from the current spec, and
 * all that stays true for UPDATE_VERIFY_SECONDS within
 * UPDATE_VERIFY_MAX_WAIT_SECONDS. Rolled back or paused updates fail at once.
 */
const waitForServiceConverged: WaitForServiceConverged = async (
  docker,
  fullName,
  options,
) => {
  const windowMs = options?.windowMs ?? envMs('UPDATE_VERIFY_SECONDS', 20);
  const maxWaitMs =
    options?.maxWaitMs ?? envMs('UPDATE_VERIFY_MAX_WAIT_SECONDS', 180);
  const pollMs = options?.pollMs ?? 2000;
  const sleep = options?.sleep ?? sleepMs;
  const now = options?.now ?? Date.now;
  const logger = getLogger();
  const started = now();

  const observe = async (): Promise<Observation> => {
    try {
      const [service, tasks] = await Promise.all([
        getService(docker, fullName),
        getServiceTasks(docker, fullName, { resolveNodes: false }),
      ]);

      return { kind: 'seen', service, tasks };
    } catch (error) {
      return { kind: 'error', error };
    }
  };

  const fail = async (reason: string): Promise<ConvergeResult> => ({
    ok: false,
    reason: `${reason}${await latestFailure(docker, fullName)}`,
  });

  const poll = async (stableSince: number | null): Promise<ConvergeResult> => {
    const observation = await observe();
    const at = now();

    if (observation.kind === 'error' && isNotFound(observation.error)) {
      return { ok: false, reason: `${fullName} does not exist` };
    }

    // The daemon can be briefly unreachable (a manager restarting): keep trying
    const verdict: Verdict =
      observation.kind === 'error'
        ? {
            kind: 'pending',
            detail: `Docker error: ${observation.error instanceof Error ? observation.error.message : String(observation.error)}`,
          }
        : judge(fullName, observation.service, observation.tasks);

    if (verdict.kind === 'failed') {
      return fail(verdict.reason);
    }

    const since = verdict.kind === 'converged' ? (stableSince ?? at) : null;

    if (since !== null && at - since >= windowMs) {
      logger.info(
        { service: fullName, waitedMs: at - started },
        '[swarm] service converged and is stable',
      );

      return { ok: true };
    }

    if (at - started >= maxWaitMs) {
      return fail(
        `${fullName} did not converge within ${Math.round(maxWaitMs / 1000)}s (${
          verdict.kind === 'pending' ? verdict.detail : 'not stable long enough'
        })`,
      );
    }

    await sleep(pollMs);

    return poll(since);
  };

  return poll(null);
};

export default waitForServiceConverged;
