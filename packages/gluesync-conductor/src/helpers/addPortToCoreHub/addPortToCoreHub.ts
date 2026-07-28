import { RawComposeService } from '../../models/composeFile.model';
import { AddPortToCoreHub } from './addPortToCoreHub.model';

const DESIRED_PORT = '8765:8765';

const addPortToCoreHub: AddPortToCoreHub = (services, serviceIds) => {
  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';

  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const svc = services[id];
      if (!svc) {
        return acc;
      }

      if (id !== coreHubName) {
        return acc;
      }

      const existingPorts = svc.ports ?? [];

      if (existingPorts.includes(DESIRED_PORT)) {
        return acc;
      }

      const nextService: RawComposeService = {
        ...svc,
        ports: [...existingPorts, DESIRED_PORT],
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

export default addPortToCoreHub;
