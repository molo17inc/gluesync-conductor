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
import { UpdateNormalBulk } from './updateNormalBulk.model';

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

const updateNormalBulk: UpdateNormalBulk = async (
  action,
  composeJson,
  requestIds,
  releaseChannel,
  { swarm = false, namespace, docker } = {},
) => {
  const { effectiveIds, skipped } = await prepareComposeUpdate(
    composeJson,
    requestIds,
    releaseChannel,
    { swarm },
  );

  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
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
  const results = await Promise.allSettled(orderedIds.map(action));

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

  return {
    orderedIds: [...orderedIds, ...skipped.map(s => s.id)],
    results: [
      ...finalResults,
      ...skipped.map(s => rejected(`${s.reason}. Not updated.`)),
    ],
  };
};

export default updateNormalBulk;
