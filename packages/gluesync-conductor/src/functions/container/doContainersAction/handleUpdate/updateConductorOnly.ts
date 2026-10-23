import editUpdateImagesInComposeFile from '../../../../helpers/editUpdatedImagesInComposeFile/editUpdateImagesInComposeFile';
import { enableUpdateMode } from '../../../../plugins/apiBlockerAsUpdating';
import rollbackServiceImages from '../../../../helpers/rollbackServiceImages/rollbackServiceImages';
import describeFailure from '../../../../helpers/describeFailure/describeFailure';
import { UpdateConductorOnly } from './updateConductorOnly.model';

const updateConductorOnly: UpdateConductorOnly = async (
  action,
  conductorInfo,
  composeJson,
) => {
  const { id, availableVersion } = conductorInfo;

  if (!availableVersion) {
    throw new Error('No available version for conductor');
  }

  const conductorVersions = {
    agentVersion: null,
    modules: [{ id, version: availableVersion }],
  };

  await editUpdateImagesInComposeFile([id], composeJson, conductorVersions);

  const results = await Promise.allSettled([id].map(action));

  const allFulfilled = results.every(r => r.status === 'fulfilled');

  if (allFulfilled) {
    enableUpdateMode();
    return { id, results };
  }

  // The pull failed: the conductor still runs its old image, so only the
  // compose file goes back (recreating would restart this very process).
  const previousImage = composeJson.services?.[id]?.image;
  if (previousImage) {
    await rollbackServiceImages([{ id, image: previousImage }], {
      recreate: false,
    });
  }
  const restoredNote = previousImage
    ? ` Compose file restored to ${previousImage}.`
    : '';
  return {
    id,
    results: results.map(r =>
      r.status === 'rejected'
        ? ({
            status: 'rejected',
            reason: {
              err: `${describeFailure(r.reason)}${restoredNote}`,
            },
          } as PromiseRejectedResult)
        : r,
    ),
  };
};

export default updateConductorOnly;
