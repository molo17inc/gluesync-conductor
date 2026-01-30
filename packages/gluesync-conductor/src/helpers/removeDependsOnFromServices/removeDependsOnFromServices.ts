import { RawComposeService } from '../../models/composeFile.model';
import { RemoveDependsOnFromServices } from './removeDependsOnFromServices.model';

/**
 * Remove depends_on property from a subset of services indicated by the provided IDs.
 * Returns cleaned services and list of IDs where depends_on was removed.
 */
const removeDependsOnFromServices: RemoveDependsOnFromServices = (
  composeJson,
  serviceIds,
) =>
  serviceIds.reduce(
    (acc, id) => {
      const service = composeJson.services?.[id];
      if (!service) {
        return acc;
      }

      const { depends_on: dependsOn, ...serviceWithNoDependsOn } = service;

      if (dependsOn) {
        return {
          cleanedServices: {
            ...acc.cleanedServices,
            [id]: serviceWithNoDependsOn,
          },
          removedDependsOnIds: [...acc.removedDependsOnIds, id],
        };
      }

      return {
        cleanedServices: {
          ...acc.cleanedServices,
          [id]: service,
        },
        removedDependsOnIds: acc.removedDependsOnIds,
      };
    },
    {
      cleanedServices: {} as Record<string, RawComposeService>,
      removedDependsOnIds: [] as ReadonlyArray<string>,
    },
  );

export default removeDependsOnFromServices;
