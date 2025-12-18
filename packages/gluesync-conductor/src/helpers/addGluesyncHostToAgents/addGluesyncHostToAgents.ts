import { composeServiceFieldConfig } from '../../models/composeFile.model';
import extractKeyValue from '../composeFile/extractKeyValue/extractKeyValue';
import { AddGluesyncHostToAgents } from './AddGluesyncHostToAgents.model';

/**
 * Add GLUESYNC_HOST in environment for the given agents,
 * but only if GLUESYNC_HOST is not already present.
 * Skips core-hub since it doesn't need to connect to itself.
 */
const addGluesyncHostToAgents: AddGluesyncHostToAgents = (
  services,
  serviceIds,
  gluesyncHost,
) => {
  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';

  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const service = services[id];
      if (!service) return acc;

      // Skip core-hub - it doesn't need GLUESYNC_HOST
      if (id === coreHubName) {
        return acc;
      }

      const normalizedEnv = extractKeyValue(
        composeServiceFieldConfig.environment.separator,
        service.environment,
      );

      if (typeof normalizedEnv.GLUESYNC_HOST !== 'undefined') {
        // Already has GLUESYNC_HOST → no change
        return acc;
      }

      const nextEnv = { ...normalizedEnv, GLUESYNC_HOST: gluesyncHost };
      const envArray = Object.entries(nextEnv).map(([k, v]) => `${k}=${v}`);

      return {
        updatedServices: {
          ...acc.updatedServices,
          [id]: { ...service, environment: envArray },
        },
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

export default addGluesyncHostToAgents;
