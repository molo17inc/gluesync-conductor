import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import parseImage from '../parseImage/parseImage';
import { EditUpdateImagesInComposeFile } from './editUpdateImagesInComposeFile.model';

const editUpdateImagesInComposeFile: EditUpdateImagesInComposeFile = async (
  containerIds,
  composeJson,
  latestVersionGA,
) => {
  const services = containerIds.map(id => {
    const service = composeJson.services?.[id];
    if (!service) {
      throw new Error(`Agent ${id} not found`);
    }

    // create updated service using found service
    const imageParts = parseImage(service.image);
    const newImage = `${imageParts.fullName}:${latestVersionGA}`;

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
