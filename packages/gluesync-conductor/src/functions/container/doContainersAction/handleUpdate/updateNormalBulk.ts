import prepareComposeUpdate from '../prepareComposeUpdate/prepareComposeUpdate';
import rollbackServiceImages from '../../../../helpers/rollbackServiceImages/rollbackServiceImages';
import describeFailure from '../../../../helpers/describeFailure/describeFailure';
import { UpdateNormalBulk } from './updateNormalBulk.model';

const rejected = (err: string): PromiseRejectedResult => ({
  status: 'rejected',
  reason: { err },
});

const updateNormalBulk: UpdateNormalBulk = async (
  action,
  composeJson,
  requestIds,
  releaseChannel,
) => {
  const { effectiveIds, skipped } = await prepareComposeUpdate(
    composeJson,
    requestIds,
    releaseChannel,
  );

  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
  const orderedIds = effectiveIds.includes(coreHubName)
    ? [coreHubName, ...effectiveIds.filter(id => id !== coreHubName)]
    : effectiveIds;

  const results = await Promise.allSettled(orderedIds.map(action));

  // Services that failed to pull, start or stay up go back to their previous
  // image, in the compose file and on the running container.
  const rollbacks = orderedIds
    .filter((_, index) => results[index].status === 'rejected')
    .map(id => ({ id, image: composeJson.services?.[id]?.image ?? '' }))
    .filter(r => r.image !== '');
  const outcomes = await rollbackServiceImages(rollbacks, { recreate: true });

  const finalResults = results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result;
    }
    const outcome = outcomes.find(o => o.id === orderedIds[index]);
    const rollbackNote = (() => {
      if (!outcome) {
        return '';
      }
      return outcome.ok
        ? ` Rolled back to ${outcome.image}.`
        : ` Rollback to ${outcome.image} failed: ${outcome.error}`;
    })();
    return rejected(`${describeFailure(result.reason)}${rollbackNote}`);
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
