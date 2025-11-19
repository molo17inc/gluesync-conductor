import editUpdateImagesInComposeFile from '../../../../helpers/editUpdatedImagesInComposeFile/editUpdateImagesInComposeFile';
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

  return { id, results };
};

export default updateConductorOnly;
