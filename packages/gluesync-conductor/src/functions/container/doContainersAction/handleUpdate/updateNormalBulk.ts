import canUpdateContainers from '../../../../helpers/canUpdateContainers/canUpdateContainers';
import fetchAllServicesInCompose from '../../../../helpers/fetchAllServicesInCompose/fetchAllServicesInCompose';
import editUpdateImagesInComposeFile from '../../../../helpers/editUpdatedImagesInComposeFile/editUpdateImagesInComposeFile';
import { LabelPrefix } from '../../../../models/composeFile.model';
import {
  UpdateNormalBulk,
  UpdateNormalBulkResult,
} from './updateNormalBulk.model';

const updateNormalBulk: UpdateNormalBulk = async (
  action,
  composeJson,
  requestIds,
  releaseChannel,
): Promise<UpdateNormalBulkResult> => {
  const initialEffectiveIds: ReadonlyArray<string> =
    requestIds.length === 0
      ? fetchAllServicesInCompose(composeJson, true, true)
          .filter(id => id !== 'gluesync-conductor')
          .filter(id => {
            const service = composeJson.services?.[id];
            if (!service) return false;

            const serviceTypeArray: ReadonlyArray<string> = Array.isArray(
              service?.labels,
            )
              ? service.labels
              : Object.entries(service?.labels || {}).map(
                  ([k, v]) => `${k}=${v}`,
                );

            return serviceTypeArray.some(label =>
              label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`),
            );
          })
      : requestIds;

  const canUpdateContainersResult = await canUpdateContainers(
    initialEffectiveIds,
    composeJson,
    releaseChannel,
  );

  if (!canUpdateContainersResult.success || !canUpdateContainersResult.data) {
    throw new Error(canUpdateContainersResult.message);
  }

  const invalidModuleIds = canUpdateContainersResult.data.modules
    .filter(m => m.version === null)
    .map(m => m.id);

  const effectiveIds = initialEffectiveIds.filter(
    id => !invalidModuleIds.includes(id),
  );

  await editUpdateImagesInComposeFile(
    effectiveIds,
    composeJson,
    canUpdateContainersResult.data,
  );

  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';

  const orderedIds: readonly string[] = effectiveIds.includes(coreHubName)
    ? [coreHubName, ...effectiveIds.filter(id => id !== coreHubName)]
    : effectiveIds;

  const results = await Promise.allSettled(orderedIds.map(action));

  return { orderedIds, results };
};

export default updateNormalBulk;
