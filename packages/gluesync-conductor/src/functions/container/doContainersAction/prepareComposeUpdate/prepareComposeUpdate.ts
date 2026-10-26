import canUpdateContainers from '../../../../helpers/canUpdateContainers/canUpdateContainers';
import fetchAllServicesInCompose from '../../../../helpers/fetchAllServicesInCompose/fetchAllServicesInCompose';
import editUpdateImagesInComposeFile from '../../../../helpers/editUpdatedImagesInComposeFile/editUpdateImagesInComposeFile';
import { LabelPrefix } from '../../../../models/composeFile.model';
import stackServiceType from '../../../../helpers/swarm/stackServiceType/stackServiceType';
import { PrepareComposeUpdate } from './prepareComposeUpdate.model';

const prepareComposeUpdate: PrepareComposeUpdate = async (
  composeJson,
  requestIds,
  releaseChannel,
  { swarm = false } = {},
) => {
  const initialEffectiveIds: ReadonlyArray<string> =
    requestIds.length === 0
      ? fetchAllServicesInCompose(composeJson, true, true)
          .filter(id => id !== 'gluesync-conductor')
          .filter(id => {
            const service = composeJson.services?.[id];
            if (!service) {
              return false;
            }

            if (swarm) {
              return stackServiceType(id, service) !== undefined;
            }

            const labels: ReadonlyArray<string> = Array.isArray(service.labels)
              ? service.labels
              : Object.entries(service.labels || {}).map(
                  ([k, v]) => `${k}=${v}`,
                );

            return labels.some(label =>
              label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`),
            );
          })
      : requestIds;

  const canUpdateResult = await canUpdateContainers(
    initialEffectiveIds,
    composeJson,
    releaseChannel,
    { swarm },
  );

  if (!canUpdateResult.success || !canUpdateResult.data) {
    throw new Error(canUpdateResult.message);
  }

  const invalidModuleIds = canUpdateResult.data.modules
    .filter(m => m.version === null)
    .map(m => m.id);

  const { skipped } = canUpdateResult.data;
  const effectiveIds = initialEffectiveIds.filter(
    id => !invalidModuleIds.includes(id) && !skipped.some(s => s.id === id),
  );

  await editUpdateImagesInComposeFile(
    effectiveIds,
    composeJson,
    canUpdateResult.data,
    { swarm },
  );

  return { effectiveIds, skipped };
};

export default prepareComposeUpdate;
