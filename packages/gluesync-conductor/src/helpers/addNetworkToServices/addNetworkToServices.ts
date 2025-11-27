import { RawComposeService } from '../../models/composeFile.model';
import { AddNetworkToServices } from './AddNetworkToServices.model';

/**
 * Ensure the given network is present in `networks` for the specified services.
 * Does not modify services where the network is already present.
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
        return {
          updatedServices: {
            ...acc.updatedServices,
            [id]: service,
          },
          updatedIds: acc.updatedIds,
        };
      }

      const nextService: RawComposeService =
        !currentNetworks || currentNetworks.length === 0
          ? ({
              ...service,
              networks: [networkName],
            } as RawComposeService)
          : ({
              ...service,
              networks: [...currentNetworks, networkName],
            } as RawComposeService);

      return {
        updatedServices: {
          ...acc.updatedServices,
          [id]: nextService,
        },
        updatedIds: [...acc.updatedIds, id],
      };
    },
    {
      updatedServices: {} as Record<string, RawComposeService>,
      updatedIds: [] as ReadonlyArray<string>,
    },
  );

  return {
    services:
      updatedIds.length === 0
        ? services
        : {
            ...services,
            ...updatedServices,
          },
    updatedIds,
  };
};

export default addNetworkToServices;
