import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import parseImage from '../parseImage/parseImage';
import { EditUpdateImagesInComposeFile } from './editUpdateImagesInComposeFile.model';
import { LabelPrefix } from '../../models/composeFile.model';

const editUpdateImagesInComposeFile: EditUpdateImagesInComposeFile = async (
  containerIds,
  composeJson,
  versions,
) => {
  const services = containerIds.map(id => {
    const service = composeJson.services?.[id];
    if (!service) {
      throw new Error(`Service ${id} not found`);
    }

    const imageParts = parseImage(service.image);

    console.log('>>>>>> labels', service.labels);

    const isAgent = service.labels?.includes(
      `${LabelPrefix.CONDUCTOR}.type=agent`,
    );

    console.log('>>>>>>>>>>> isAgent', isAgent);

    const isCoreHub = service.labels?.includes(
      `${LabelPrefix.CONDUCTOR}.type=core-hub`,
    );

    console.log('>>>>>>>>>>> isCoreHub', isCoreHub);

    console.log('>>>>>>>>>>> agentVersion', versions.agentVersion);

    const newVersion =
      isAgent || isCoreHub
        ? versions.agentVersion
        : (versions.modules.find(m => m.id === id)?.version ?? null);

    if (!newVersion) {
      throw new Error(`No version available for service ${id}`);
    }

    const newImage = `${imageParts.fullName}:${newVersion}`;

    return [id, { ...service, image: newImage }] as const;
  });

  const updatedServices = {
    ...composeJson.services,
    ...Object.fromEntries(services),
  };

  const composeFile = {
    ...composeJson,
    services: updatedServices,
  };

  await writeComposeFile(composeFile);
};

export default editUpdateImagesInComposeFile;
