import prepareComposeUpdate from '../migrationWithUpdate/prepareComposeUpdate';
import { UpdateNormalBulk } from './updateNormalBulk.model';

const updateNormalBulk: UpdateNormalBulk = async (
  action,
  composeJson,
  requestIds,
  releaseChannel,
) => {
  const effectiveIds = await prepareComposeUpdate(
    composeJson,
    requestIds,
    releaseChannel,
  );

  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';

  const orderedIds = effectiveIds.includes(coreHubName)
    ? [coreHubName, ...effectiveIds.filter(id => id !== coreHubName)]
    : effectiveIds;

  const results = await Promise.allSettled(orderedIds.map(action));

  return { orderedIds, results };
};

export default updateNormalBulk;
