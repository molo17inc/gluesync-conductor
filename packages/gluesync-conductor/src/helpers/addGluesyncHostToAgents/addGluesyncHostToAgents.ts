import {
  RawComposeService,
  composeServiceFieldConfig,
} from '../../models/composeFile.model';
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

      const hasGluesyncHost =
        typeof normalizedEnv.GLUESYNC_HOST !== 'undefined';

      if (hasGluesyncHost) {
        return {
          updatedServices: {
            ...acc.updatedServices,
            [id]: service,
          },
          updatedIds: acc.updatedIds,
        };
      }

      const nextEnv = {
        ...normalizedEnv,
        GLUESYNC_HOST: gluesyncHost,
      };

      const envArray = Object.entries(nextEnv).map(
        ([key, value]) => `${key}=${value}`,
      );

      const nextService: RawComposeService = {
        ...service,
        environment: envArray,
      };

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

  // If nothing changed, return original reference to make no-op explicit
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

export default addGluesyncHostToAgents;
