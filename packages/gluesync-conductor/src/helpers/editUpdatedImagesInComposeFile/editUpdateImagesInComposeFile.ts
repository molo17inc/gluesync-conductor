import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import parseImage from '../parseImage/parseImage';
import { EditUpdateImagesInComposeFile } from './editUpdateImagesInComposeFile.model';
import { LabelPrefix } from '../../models/composeFile.model';
import stackServiceType from '../swarm/stackServiceType/stackServiceType';
import { cpuCompatibleChronosUpdateImage } from '../applyCpuCompatibilityToImage/applyCpuCompatibilityToImage';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

const editUpdateImagesInComposeFile: EditUpdateImagesInComposeFile = async (
  containerIds,
  composeJson,
  versions,
  { swarm = false } = {},
) => {
  const services = await Promise.all(
    containerIds.map(async id => {
      const service = composeJson.services?.[id];
      if (!service) {
        throw new Error(`Service ${id} not found`);
      }

      const imageParts = parseImage(service.image);

      // `image:${TAG:-2.3.0}` is the customer's to change: rewriting it would
      // drop the variable
      if (imageParts.interpolatedTag) {
        return [id, service] as const;
      }

      const labels = Array.isArray(service.labels)
        ? service.labels
        : Object.entries(service.labels || {}).map(([k, v]) => `${k}=${v}`);

      const swarmType = swarm ? stackServiceType(id, service) : undefined;
      const isAgent = swarm
        ? swarmType === 'agent'
        : labels.includes(`${LabelPrefix.CONDUCTOR}.type=agent`);
      const isCoreHub = swarm
        ? swarmType === 'core-hub'
        : labels.includes(`${LabelPrefix.CONDUCTOR}.type=core-hub`);

      const newVersion =
        isAgent || isCoreHub
          ? versions.agentVersion
          : (versions.modules.find(m => m.id === id)?.version ?? null);

      if (!newVersion) {
        throw new Error(`No version available for service ${id}`);
      }

      // Preserve suffix if present
      const dashIndex = imageParts.tag.indexOf('-');
      const tagSuffix =
        dashIndex !== -1 ? imageParts.tag.slice(dashIndex + 1) : '';

      const rewrittenImage = `${imageParts.fullName}:${newVersion}${
        tagSuffix ? `-${tagSuffix}` : ''
      }`;

      // Chronos on an old Linux CPU moves to `<new>-debian` when that image
      // exists (Core Hub keeps the suffix it already has, like any other)
      const newImage = swarm
        ? rewrittenImage
        : await cpuCompatibleChronosUpdateImage(rewrittenImage, isWindows);

      return [id, { ...service, image: newImage }] as const;
    }),
  );

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
