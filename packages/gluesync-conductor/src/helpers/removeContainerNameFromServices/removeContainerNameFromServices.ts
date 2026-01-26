import { RawComposeService } from '../../models/composeFile.model';
import { RemoveContainerNameFromServices } from './removeContainerNameFromServices.model';

/**
 * Remove container_name property from a subset of services indicated by the provided IDs.
 * Returns cleaned services and list of IDs where container_name was removed.
 */
const removeContainerNameFromServices: RemoveContainerNameFromServices = (
  composeJson,
  serviceIds,
) =>
  serviceIds.reduce(
    (acc, id) => {
      const service = composeJson.services?.[id];
      if (!service) return acc;

      const { container_name: containerName, ...serviceWithNoContainerName } =
        service as RawComposeService & { container_name?: string };

      if (containerName) {
        return {
          cleanedServices: {
            ...acc.cleanedServices,
            [id]: serviceWithNoContainerName,
          },
          removedContainerNameIds: [...acc.removedContainerNameIds, id],
        };
      }

      return {
        cleanedServices: {
          ...acc.cleanedServices,
          [id]: service,
        },
        removedContainerNameIds: acc.removedContainerNameIds,
      };
    },
    {
      cleanedServices: {} as Record<string, RawComposeService>,
      removedContainerNameIds: [] as ReadonlyArray<string>,
    },
  );

export default removeContainerNameFromServices;
