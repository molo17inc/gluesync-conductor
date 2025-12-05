import { RawComposeService } from '../../models/composeFile.model';
import { AddNetworkToServices } from './AddNetworkToServices.model';

/**
 * Ensure the given network is present in `networks` for the specified services.
 * Only modifies services where the network is missing.
 */
const addNetworkToServices: AddNetworkToServices = (
  services,
  serviceIds,
  networkName,
) => {
  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const service = services[id];
      if (!service) return acc;

      const currentNetworks = (service as { networks?: ReadonlyArray<string> })
        .networks;

      if (currentNetworks && currentNetworks.includes(networkName)) {
        // Network already present → no change
        return acc;
      }

      const nextService: RawComposeService = {
        ...service,
        networks:
          currentNetworks && currentNetworks.length > 0
            ? [...currentNetworks, networkName]
            : [networkName],
      };

      return {
        updatedServices: { ...acc.updatedServices, [id]: nextService },
        updatedIds: [...acc.updatedIds, id],
      };
    },
    { updatedServices: {}, updatedIds: [] as ReadonlyArray<string> },
  );

  return {
    services:
      updatedIds.length === 0 ? services : { ...services, ...updatedServices },
    updatedIds,
  };
};

export default addNetworkToServices;
