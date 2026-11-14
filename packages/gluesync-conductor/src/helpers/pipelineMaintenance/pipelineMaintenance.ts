import { getLogger } from '../../utils/logger';
import createCoreHubPipelinesApi from './coreHubPipelinesApi';
import {
  CoreHubPipeline,
  CoreHubPipelinesApi,
} from './coreHubPipelinesApi.model';
import createPausedPipelinesStore from './pausedPipelinesStore';
import {
  CoreHubApiError,
  CoreHubUnreachableError,
  UpdateRefusedByPipelinesError,
} from './pipelineMaintenance.errors';
import {
  MaintenanceClock,
  NotResumed,
  PauseOutcome,
  PausedPipelinesStore,
  PipelineMaintenance,
  PipelineMaintenanceOptions,
  ResumeOutcome,
} from './pipelineMaintenance.model';

// Defaults, in seconds, of UPDATE_MAINTENANCE_DRAIN_TIMEOUT_SECONDS and
// UPDATE_MAINTENANCE_RESUME_TIMEOUT_SECONDS (see README "Updates")
export const DEFAULT_DRAIN_TIMEOUT_SECONDS = 300;
export const DEFAULT_RESUME_TIMEOUT_SECONDS = 300;
const POLL_MS = 2000;

const envSeconds = (name: string, fallbackSeconds: number): number => {
  const raw = Number(process.env[name]);
  return (Number.isFinite(raw) && raw > 0 ? raw : fallbackSeconds) * 1000;
};

/** UPDATE_PIPELINE_MAINTENANCE=false turns the whole thing off. */
export const isPipelineMaintenanceEnabled = (): boolean =>
  process.env.UPDATE_PIPELINE_MAINTENANCE?.trim().toLowerCase() !== 'false';

const realClock: MaintenanceClock = {
  now: () => Date.now(),
  sleep: ms =>
    new Promise(resolve => {
      setTimeout(resolve, ms);
    }),
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const list = (ids: ReadonlyArray<string>): string => ids.join(', ');

type Entering = Readonly<{
  settled: () => boolean;
  error: () => string | undefined;
}>;

// The enter call runs on: Core Hub answers once the pipeline is drained, and a
// request dropped by the client could leave the drain half done
const track = (promise: Promise<void>): Entering => {
  const state = new Map<'settled' | 'error', string | boolean>();
  promise.then(
    () => state.set('settled', true),
    error => {
      state.set('error', errorText(error));
      state.set('settled', true);
    },
  );
  return {
    settled: () => state.get('settled') === true,
    error: () => state.get('error') as string | undefined,
  };
};

type DrainResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; statusCode: number; title: string; details: string }>;

/**
 * Before an update changes Core Hub's image, every running pipeline goes into
 * Core Hub's maintenance mode (sync drained and stopped gracefully); once Core
 * Hub is back and stable, or rolled back, the same pipelines are taken out of
 * it. Pipelines that were stopped or already in maintenance are left alone.
 * The list is kept on disk until they are all resumed.
 */
const createPipelineMaintenance = (
  options: PipelineMaintenanceOptions = {},
): PipelineMaintenance => {
  const api: CoreHubPipelinesApi = options.api ?? createCoreHubPipelinesApi();
  const store: PausedPipelinesStore =
    options.store ?? createPausedPipelinesStore();
  const clock = options.clock ?? realClock;
  const drainTimeoutMs =
    options.drainTimeoutMs ??
    envSeconds(
      'UPDATE_MAINTENANCE_DRAIN_TIMEOUT_SECONDS',
      DEFAULT_DRAIN_TIMEOUT_SECONDS,
    );
  const resumeTimeoutMs =
    options.resumeTimeoutMs ??
    envSeconds(
      'UPDATE_MAINTENANCE_RESUME_TIMEOUT_SECONDS',
      DEFAULT_RESUME_TIMEOUT_SECONDS,
    );
  const pollMs = options.pollMs ?? POLL_MS;
  const logger = getLogger();

  const nap = (deadline: number): Promise<void> =>
    clock.sleep(Math.max(0, Math.min(pollMs, deadline - clock.now())));

  // ------------------------------------------------------------- resume

  // Each round lists the pipelines and takes out of maintenance the ones still
  // in it; what failed, or is still entering, is tried again after a nap
  /* eslint-disable functional/no-let, functional/no-loop-statements, no-await-in-loop, no-restricted-syntax -- a retry loop: each round waits for the last */
  const resumeLoop = async (
    ids: ReadonlyArray<string>,
    pending: (id: string) => boolean,
    deadline: number,
  ): Promise<ResumeOutcome> => {
    const errors = new Map<string, string>();
    let resumed: ReadonlyArray<string> = [];
    let left = ids;

    while (left.length > 0) {
      try {
        const byId = new Map(
          (await api.listPipelines()).map(p => [p.id, p] as const),
        );
        // In maintenance: take it out. Gone, or out of maintenance (by hand,
        // or it never got in) with no enter call still running: nothing to do
        const toExit = left.filter(id => byId.get(id)?.isInMaintenanceMode);
        const waiting = left.filter(
          id =>
            byId.has(id) && !byId.get(id)?.isInMaintenanceMode && pending(id),
        );
        const results = await Promise.allSettled(
          toExit.map(id => api.exitMaintenance(id)),
        );
        results.forEach((result, i) => {
          if (result.status === 'rejected') {
            errors.set(toExit[i], errorText(result.reason));
          }
        });
        const exited = toExit.filter(
          (_, i) => results[i].status === 'fulfilled',
        );
        const failed = toExit.filter(
          (_, i) => results[i].status === 'rejected',
        );
        resumed = [...resumed, ...exited];
        left = [...failed, ...waiting];
      } catch (error) {
        left.forEach(id => errors.set(id, errorText(error)));
      }

      if (left.length === 0 || clock.now() >= deadline) {
        break;
      }
      await nap(deadline);
    }

    return {
      resumed,
      notResumed: left.map(
        (id): NotResumed => ({
          id,
          error: errors.get(id) ?? 'still entering maintenance mode',
        }),
      ),
    };
  };
  /* eslint-enable functional/no-let, functional/no-loop-statements, no-await-in-loop, no-restricted-syntax */

  const resumeIds = async (
    ids: ReadonlyArray<string>,
    pending: (id: string) => boolean = () => false,
  ): Promise<ResumeOutcome> => {
    const outcome = await resumeLoop(
      ids,
      pending,
      clock.now() + resumeTimeoutMs,
    );
    const left = outcome.notResumed.map(n => n.id);

    // What is still in maintenance stays on disk: the next start of the
    // Conductor (or the next update) tries again
    try {
      if (left.length > 0) {
        await store.write({
          pausedAt: new Date(clock.now()).toISOString(),
          pipelineIds: left,
        });
      } else {
        await store.clear();
      }
    } catch (error) {
      logger.error(
        { error, left },
        '[pipeline-maintenance] could not update the paused pipelines file',
      );
    }

    if (outcome.resumed.length > 0) {
      logger.info(
        { pipelines: outcome.resumed },
        '[pipeline-maintenance] pipelines taken out of maintenance mode',
      );
    }
    if (left.length > 0) {
      logger.error(
        { notResumed: outcome.notResumed },
        '[pipeline-maintenance] pipelines still in maintenance mode, retried at the next Conductor start',
      );
    }
    return outcome;
  };

  const resume = async (): Promise<ResumeOutcome> => {
    const record = await store.read();
    return record && record.pipelineIds.length > 0
      ? resumeIds(record.pipelineIds)
      : { resumed: [], notResumed: [] };
  };

  // -------------------------------------------------------------- pause

  const nothingPaused = (error: unknown): UpdateRefusedByPipelinesError =>
    error instanceof CoreHubUnreachableError
      ? new UpdateRefusedByPipelinesError(
          503,
          'Update refused: Core Hub did not answer',
          `${errorText(error)}. Within ${Math.round(drainTimeoutMs / 1000)}s (UPDATE_MAINTENANCE_DRAIN_TIMEOUT_SECONDS) no pipeline could be put in maintenance mode, so none was paused and no image was changed. If Core Hub is down, update it with UPDATE_PIPELINE_MAINTENANCE=false set on the Conductor.`,
          { resumed: [], notResumed: [] },
        )
      : new UpdateRefusedByPipelinesError(
          502,
          'Update refused: could not read the pipelines from Core Hub',
          `${errorText(error)}. No pipeline was paused and no image was changed.`,
          { resumed: [], notResumed: [] },
        );

  // A Core Hub that does not answer (restarting, the SDK reconnecting) is
  // waited for until the drain deadline, then the update is refused: Core
  // Hub's image never changes while a pipeline may still be syncing. One
  // that answers with an error refuses it at once.
  const listForPause = async (
    deadline: number,
  ): Promise<ReadonlyArray<CoreHubPipeline> | string> => {
    try {
      return await api.listPipelines();
    } catch (error) {
      // A Core Hub older than the pipeline API (it is in 2.2.9 and later):
      // there is nothing to pause through it, the update goes on as before
      if (error instanceof CoreHubApiError && error.status === 404) {
        return `Core Hub has no pipeline API (${error.message})`;
      }
      if (!(error instanceof CoreHubUnreachableError)) {
        throw nothingPaused(error);
      }
      if (clock.now() >= deadline) {
        throw nothingPaused(error);
      }
      await nap(deadline);
      return listForPause(deadline);
    }
  };

  // Same rule as listForPause: a Core Hub that does not answer is waited for
  // until the drain deadline, one that answers with an error refuses at once
  const runningAmong = async (
    pipelines: ReadonlyArray<CoreHubPipeline>,
    deadline: number,
  ): Promise<ReadonlyArray<string>> => {
    const candidates = pipelines.filter(
      p => p.configurationCompleted && !p.isInMaintenanceMode,
    );
    try {
      const running = await Promise.all(
        candidates.map(p => api.isRunning(p.id)),
      );
      return candidates.filter((_, i) => running[i]).map(p => p.id);
    } catch (error) {
      if (
        !(error instanceof CoreHubUnreachableError) ||
        clock.now() >= deadline
      ) {
        throw nothingPaused(error);
      }
      await nap(deadline);
      return runningAmong(pipelines, deadline);
    }
  };

  // Core Hub answers the enter call only once the pipeline is stopped and its
  // maintenance flag saved (PipelineServicesManager.enterMaintenanceMode), so
  // an answered call is a drained pipeline: no need to list them again
  const waitDrained = async (
    ids: ReadonlyArray<string>,
    entering: ReadonlyMap<string, Entering>,
    deadline: number,
  ): Promise<DrainResult> => {
    const failed = ids.filter(id => entering.get(id)?.error());
    if (failed.length > 0) {
      return {
        ok: false,
        statusCode: 502,
        title:
          'Update refused: Core Hub could not put every running pipeline in maintenance mode',
        details: failed.map(id => entering.get(id)?.error() ?? id).join('; '),
      };
    }

    const notYet = ids.filter(id => !entering.get(id)?.settled());

    if (notYet.length === 0) {
      return { ok: true };
    }
    if (clock.now() >= deadline) {
      return {
        ok: false,
        statusCode: 409,
        title:
          'Update refused: the running pipelines did not enter maintenance mode in time',
        details: `Not drained within ${Math.round(drainTimeoutMs / 1000)}s (UPDATE_MAINTENANCE_DRAIN_TIMEOUT_SECONDS): ${list(notYet)}.`,
      };
    }
    await nap(deadline);
    return waitDrained(ids, entering, deadline);
  };

  const refuse = async (
    held: ReadonlyArray<string>,
    entering: ReadonlyMap<string, Entering>,
    drain: Extract<DrainResult, { ok: false }>,
  ): Promise<never> => {
    logger.warn(
      { pipelines: held, reason: drain.details },
      '[pipeline-maintenance] update refused, resuming the pipelines paused for it',
    );
    const outcome = await resumeIds(
      held,
      id => entering.get(id)?.settled() === false,
    );
    const resumedText =
      outcome.resumed.length > 0 ? ` Resumed: ${list(outcome.resumed)}.` : '';
    const notResumedText =
      outcome.notResumed.length > 0
        ? ` Still in maintenance mode (the Conductor retries at its next start): ${list(outcome.notResumed.map(n => n.id))}.`
        : '';
    throw new UpdateRefusedByPipelinesError(
      drain.statusCode,
      drain.title,
      `${drain.details} No image was changed.${resumedText}${notResumedText}`,
      {
        resumed: outcome.resumed,
        notResumed: outcome.notResumed.map(n => n.id),
      },
    );
  };

  const pause = async (): Promise<PauseOutcome> => {
    // Paused by an earlier update and never resumed: this update holds them too
    const carried = (await store.read())?.pipelineIds ?? [];
    // The whole pause, Core Hub's first answer included, has the drain timeout
    const deadline = clock.now() + drainTimeoutMs;
    const pipelines = await listForPause(deadline);

    if (typeof pipelines === 'string') {
      logger.warn(
        { reason: pipelines },
        '[pipeline-maintenance] no pipeline API on this Core Hub: updating without pausing the pipelines',
      );
      return {
        paused: [],
        alreadyInMaintenance: [],
        notPausedReason: pipelines,
      };
    }

    const byId = new Map(pipelines.map(p => [p.id, p]));
    const carriedStill = carried.filter(
      id => byId.get(id)?.isInMaintenanceMode,
    );
    const alreadyInMaintenance = pipelines
      .filter(p => p.isInMaintenanceMode && !carriedStill.includes(p.id))
      .map(p => p.id);
    const toPause = await runningAmong(pipelines, deadline);
    const held = [...carriedStill, ...toPause];

    if (held.length === 0) {
      if (carried.length > 0) {
        await store.clear();
      }
      logger.info(
        { alreadyInMaintenance },
        '[pipeline-maintenance] no running pipeline to pause',
      );
      return { paused: [], alreadyInMaintenance };
    }

    // On disk before the first command: a Conductor restarted from here on
    // still resumes them (one that never got in is simply left alone)
    await store.write({
      pausedAt: new Date(clock.now()).toISOString(),
      pipelineIds: held,
    });

    logger.info(
      { pipelines: toPause, carried: carriedStill, alreadyInMaintenance },
      '[pipeline-maintenance] putting the running pipelines in maintenance mode',
    );
    const entering = new Map(
      toPause.map(id => [id, track(api.enterMaintenance(id))]),
    );
    const drain = await waitDrained(toPause, entering, deadline);

    if (!drain.ok) {
      return refuse(held, entering, drain);
    }

    logger.info(
      { pipelines: held },
      '[pipeline-maintenance] every running pipeline is in maintenance mode',
    );
    return { paused: held, alreadyInMaintenance };
  };

  return { pause, resume };
};

export default createPipelineMaintenance;
