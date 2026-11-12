import type Docker from 'dockerode';
import prepareComposeUpdate from '../prepareComposeUpdate/prepareComposeUpdate';
import rollbackServiceImages from '../../../../helpers/rollbackServiceImages/rollbackServiceImages';
import { RollbackOutcome } from '../../../../helpers/rollbackServiceImages/rollbackServiceImages.model';
import describeFailure from '../../../../helpers/describeFailure/describeFailure';
import isTransientDockerConnError from '../../../../helpers/dockerode/isTransientDockerConnError/isTransientDockerConnError';
import { fingerprintServices } from '../../../../helpers/serviceContainers/serviceContainers';
import fingerprintSwarmServices from '../../../../helpers/swarm/fingerprintSwarmServices/fingerprintSwarmServices';
import type { Fingerprints } from '../../../../helpers/serviceContainers/serviceContainers.model';
import { getLogger } from '../../../../utils/logger';
import {
  PauseOutcome,
  PipelineMaintenance,
  ResumeOutcome,
} from '../../../../helpers/pipelineMaintenance/pipelineMaintenance.model';
import {
  UpdateNormalBulk,
  UpdatePipelinesReport,
} from './updateNormalBulk.model';

const rejected = (err: string): PromiseRejectedResult => ({
  status: 'rejected',
  reason: { err },
});

// What the containers of the update set look like before anything is
// recreated, so a rollback can tell the services the update touched from the
// ones it never reached. Docker being down now only means "unknown".
const snapshotBefore = async (
  docker: Readonly<Docker>,
  ids: ReadonlyArray<string>,
  namespace?: string,
): Promise<Fingerprints | undefined> => {
  try {
    return namespace
      ? await fingerprintSwarmServices(docker, namespace, ids)
      : await fingerprintServices(docker, ids);
  } catch (error) {
    getLogger().warn(
      { error: describeFailure(error) },
      '[update] could not snapshot the containers before the update',
    );
    return undefined;
  }
};

// A pull or a recreate that failed because the Docker API was gone.
const isDockerOutage = (reason: unknown): boolean =>
  isTransientDockerConnError(reason) ||
  isTransientDockerConnError({ message: describeFailure(reason) });

const outcomeNote = (outcome: RollbackOutcome, outage: boolean): string => {
  if (!outcome.ok) {
    return outcome.image
      ? ` Rollback to ${outcome.image} failed: ${outcome.error}`
      : ` Not restored: ${outcome.error}`;
  }
  if (!outcome.untouched) {
    return ` Rolled back to ${outcome.image}.`;
  }
  return outage
    ? ' Docker was unavailable; nothing was changed.'
    : ` Compose file restored to ${outcome.image}; the running container was not touched.`;
};

type PipelineHold = Readonly<{
  // Before the images change, when Core Hub is part of the update
  pauseIfCoreHub: (effectiveIds: readonly string[]) => Promise<void>;
  isHolding: () => boolean;
  // Once, however often it is called: when Core Hub is stable, or after its
  // rollback
  resume: () => Promise<ResumeOutcome | undefined>;
  report: (resumed?: ResumeOutcome) => UpdatePipelinesReport | undefined;
}>;

const holdPipelines = (
  coreHubName: string,
  maintenance: PipelineMaintenance | undefined,
): PipelineHold => {
  const state = new Map<'pause', PauseOutcome>();
  const resuming = new Map<'resume', Promise<ResumeOutcome>>();

  return {
    pauseIfCoreHub: async effectiveIds => {
      if (maintenance && effectiveIds.includes(coreHubName)) {
        state.set('pause', await maintenance.pause());
      }
    },
    isHolding: () => state.has('pause'),
    resume: async () => {
      if (!maintenance || !state.has('pause')) {
        return undefined;
      }
      const running = resuming.get('resume') ?? maintenance.resume();
      resuming.set('resume', running);
      return running;
    },
    report: resumed => {
      const paused = state.get('pause');
      return paused
        ? {
            service: coreHubName,
            paused: paused.paused,
            resumed: resumed?.resumed ?? [],
            notResumed: resumed?.notResumed ?? [],
            alreadyInMaintenance: paused.alreadyInMaintenance,
            ...(paused.coreHubUnreachable && {
              coreHubUnreachable: paused.coreHubUnreachable,
            }),
          }
        : undefined;
    },
  };
};

// eslint-disable-next-line functional/no-mixed-types -- the arguments of updateNormalBulk, passed on
type RunUpdateArgs = Readonly<{
  action: Parameters<UpdateNormalBulk>[0];
  composeJson: Parameters<UpdateNormalBulk>[1];
  effectiveIds: readonly string[];
  skipped: ReadonlyArray<Readonly<{ id: string; reason: string }>>;
  coreHubName: string;
  swarm: boolean;
  namespace?: string;
  docker?: Readonly<Docker>;
  hold: PipelineHold;
}>;

const runUpdate = async ({
  action,
  composeJson,
  effectiveIds,
  skipped,
  coreHubName,
  swarm,
  namespace,
  docker,
  hold,
}: RunUpdateArgs) => {
  const orderedIds = effectiveIds.includes(coreHubName)
    ? [coreHubName, ...effectiveIds.filter(id => id !== coreHubName)]
    : effectiveIds;

  // Compose, or a Swarm stack whose services can be fingerprinted and restored
  const restorable = Boolean(docker) && (!swarm || Boolean(namespace));
  const stack = swarm ? namespace : undefined;
  const before =
    docker && restorable
      ? await snapshotBefore(docker, orderedIds, stack)
      : undefined;
  // Core Hub's update resolves once it passed the stability check: its
  // pipelines resume right then, without waiting for the modules, which carry
  // no sync
  const run = (id: string): Promise<any> =>
    id === coreHubName && hold.isHolding()
      ? action(id).then(async value => {
          await hold.resume();
          return value;
        })
      : action(id);
  const results = await Promise.allSettled(orderedIds.map(run));

  // Services that failed to pull, start or stay up go back to their previous
  // image, in the compose file and on the running container (after Docker
  // answers again; only the ones the update actually touched). Then every
  // service of the update set is checked to be running. On Swarm the update
  // action has already used Swarm's own rollback: what is left is the outage
  // case, and the final check of every service.
  const rollbacks = orderedIds
    .filter((_, index) => results[index].status === 'rejected')
    .map(id => ({ id, image: composeJson.services?.[id]?.image ?? '' }))
    .filter(r => r.image !== '');
  const outcomes = await rollbackServiceImages(
    rollbacks,
    docker && restorable
      ? {
          recreate: true,
          docker,
          before,
          services: orderedIds,
          ...(swarm && namespace && { swarm: { namespace } }),
        }
      : { recreate: false },
  );

  const finalResults = results.map((result, index) => {
    const outcome = outcomes.find(o => o.id === orderedIds[index]);
    if (result.status === 'fulfilled') {
      // Reported OK, but the service is not running what it should after the
      // rollback of the others: never claim OK for that.
      return outcome?.ok === false
        ? rejected(`${String(result.value)} But now: ${outcome.error}`)
        : result;
    }
    const note = outcome
      ? outcomeNote(outcome, isDockerOutage(result.reason))
      : '';
    return rejected(`${describeFailure(result.reason)}${note}`);
  });

  // A failed Core Hub has been rolled back by now: its pipelines resume on the
  // previous version
  const pipelines = hold.report(await hold.resume());

  return {
    orderedIds: [...orderedIds, ...skipped.map(s => s.id)],
    results: [
      ...finalResults,
      ...skipped.map(s => rejected(`${s.reason}. Not updated.`)),
    ],
    ...(pipelines && { pipelines }),
  };
};

const updateNormalBulk: UpdateNormalBulk = async (
  action,
  composeJson,
  requestIds,
  releaseChannel,
  { swarm = false, namespace, docker, pipelineMaintenance } = {},
) => {
  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
  const hold = holdPipelines(coreHubName, pipelineMaintenance);

  // Refused here (drain timeout, Core Hub error): nothing written, no image
  // changed, the pipelines paused so far already resumed
  const { effectiveIds, skipped } = await prepareComposeUpdate(
    composeJson,
    requestIds,
    releaseChannel,
    { swarm, beforeImagesChange: hold.pauseIfCoreHub },
  );

  // try/finally: whatever happens below, paused pipelines are resumed
  try {
    return await runUpdate({
      action,
      composeJson,
      effectiveIds,
      skipped,
      coreHubName,
      swarm,
      namespace,
      docker,
      hold,
    });
  } finally {
    await hold.resume();
  }
};

export default updateNormalBulk;
