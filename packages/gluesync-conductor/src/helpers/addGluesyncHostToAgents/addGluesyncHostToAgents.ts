import { composeServiceFieldConfig } from '../../models/composeFile.model';
import extractKeyValue from '../composeFile/extractKeyValue/extractKeyValue';
import { AddGluesyncHostToAgents } from './AddGluesyncHostToAgents.model';

/**
 * Add GLUESYNC_HOST in environment for the given agents,
 * but only if GLUESYNC_HOST is not already present.
 */
const addGluesyncHostToAgents: AddGluesyncHostToAgents = (
  services,
  serviceIds,
  gluesyncHost,
) => {
  const { updatedServices, updatedIds } = serviceIds.reduce(
    (acc, id) => {
      const service = services[id];
      if (!service) return acc;

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
