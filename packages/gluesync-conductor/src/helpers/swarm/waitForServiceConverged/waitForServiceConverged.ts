import type Docker from 'dockerode';

import { getLogger } from '../../../utils/logger';
import describeFailure from '../../describeFailure/describeFailure';
import isTransientDockerConnError from '../../dockerode/isTransientDockerConnError/isTransientDockerConnError';
import waitForDockerOutage from '../../dockerode/waitForDockerOutage/waitForDockerOutage';
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
  // pulling: a task of the current spec is still getting its image
  | Readonly<{ kind: 'pending'; detail: string; pulling: boolean }>
  | Readonly<{ kind: 'failed'; reason: string }>;

// Swarm pulls the image of a task while the task is `preparing`
const PULLING_STATE = 'preparing';

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
  const isCurrent = (task: Readonly<SwarmTask>): boolean =>
    task.image === service.image && task.forceUpdate === forceUpdate;
  const onCurrentSpec = tasks.every(isCurrent);
  const pulling = tasks.some(
    task => isCurrent(task) && task.state === PULLING_STATE && !task.err,
  );
  const detail = `update ${state ?? 'none'}, ${running}/${expected} tasks running${
    pulling ? ', pulling the image' : ''
  }`;

  return (!state || state === 'completed') &&
    onCurrentSpec &&
    running === expected &&
    tasks.length === expected &&
    (service.replicas !== undefined || expected > 0)
    ? { kind: 'converged' }
    : { kind: 'pending', detail, pulling };
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
 *
 * Swarm pulls the new image while the task is starting, unlike `compose pull`
 * before `up`: the time spent pulling does not count against
 * UPDATE_VERIFY_MAX_WAIT_SECONDS, so a large image (a Windows one is gigabytes)
 * is not rolled back for being slow to download. UPDATE_PULL_MAX_WAIT_SECONDS
 * bounds the pull itself.
 */
const waitForServiceConverged: WaitForServiceConverged = async (
  docker,
  fullName,
  options,
) => {
  const windowMs = options?.windowMs ?? envMs('UPDATE_VERIFY_SECONDS', 20);
  const maxWaitMs =
    options?.maxWaitMs ?? envMs('UPDATE_VERIFY_MAX_WAIT_SECONDS', 180);
  const maxPullMs =
    options?.maxPullMs ?? envMs('UPDATE_PULL_MAX_WAIT_SECONDS', 1200);
  const pollMs = options?.pollMs ?? 2000;
  const sleep = options?.sleep ?? sleepMs;
  const now = options?.now ?? Date.now;
  const waitForDocker = options?.waitForDocker ?? waitForDockerOutage;
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

  // A Docker API that dropped says nothing about the service: wait for it
  // (CONDUCTOR_DOCKER_WAIT_MS) instead of judging the service meanwhile.
  // Resolves to why Docker did not come back, when it did not.
  const outageFailure = async (
    observation: Observation,
  ): Promise<string | undefined> => {
    if (
      observation.kind !== 'error' ||
      !isTransientDockerConnError(observation.error)
    ) {
      return undefined;
    }

    logger.warn(
      { service: fullName, error: describeFailure(observation.error) },
      '[swarm] Docker did not answer, waiting for it',
    );

    try {
      await waitForDocker(docker);

      return undefined;
    } catch (error) {
      return describeFailure(error);
    }
  };

  const fail = async (reason: string): Promise<ConvergeResult> => ({
    ok: false,
    reason: `${reason}${await latestFailure(docker, fullName)}`,
  });

  // stableSince: converged since then; pulledMs: time spent pulling so far,
  // up to lastAt, the time of the previous look
  const poll = async (
    stableSince: number | null,
    pulledMs: number,
    lastAt: number,
  ): Promise<ConvergeResult> => {
    const observation = await observe();
    const at = now();

    if (observation.kind === 'error' && isNotFound(observation.error)) {
      return { ok: false, reason: `${fullName} does not exist` };
    }

    const down = await outageFailure(observation);

    if (down) {
      return fail(`${fullName}: Docker is not reachable: ${down}`);
    }

    // The daemon can be briefly unreachable (a manager restarting): keep trying
    const verdict: Verdict =
      observation.kind === 'error'
        ? {
            kind: 'pending',
            detail: `Docker error: ${observation.error instanceof Error ? observation.error.message : String(observation.error)}`,
            pulling: false,
          }
        : judge(fullName, observation.service, observation.tasks);

    if (verdict.kind === 'failed') {
      return fail(verdict.reason);
    }

    const since = verdict.kind === 'converged' ? (stableSince ?? at) : null;
    const pulling = verdict.kind === 'pending' && verdict.pulling;
    const pulled = pulledMs + (pulling ? at - lastAt : 0);

    if (since !== null && at - since >= windowMs) {
      logger.info(
        { service: fullName, waitedMs: at - started },
        '[swarm] service converged and is stable',
      );

      return { ok: true };
    }

    if (pulling && pulled >= maxPullMs) {
      return fail(
        `${fullName} image pull did not finish within ${Math.round(maxPullMs / 1000)}s`,
      );
    }

    if (at - started - pulled >= maxWaitMs) {
      return fail(
        `${fullName} did not converge within ${Math.round(maxWaitMs / 1000)}s (${
          verdict.kind === 'pending' ? verdict.detail : 'not stable long enough'
        })`,
      );
    }

    await sleep(pollMs);

    return poll(since, pulled, at);
  };

  return poll(null, 0, started);
};

export default waitForServiceConverged;
