import { composeServiceFieldConfig } from '../../models/composeFile.model';
import extractKeyValue from '../composeFile/extractKeyValue/extractKeyValue';
import { AddGluesyncHostToChronos } from './AddGluesyncHostToChronos.model';

/**
 * Adds GLUESYNC_HOST to gluesync-chronos service environment
 * only if it is not already present.
 */
const addGluesyncHostToChronos: AddGluesyncHostToChronos = (
  services,
  gluesyncHost,
) => {
  const chronosServiceName = 'gluesync-chronos';

  const service = services[chronosServiceName];
  if (!service) {
    return { services, updatedIds: [] };
  }

  // normalize environment array -> object
  const normalizedEnv = extractKeyValue(
    composeServiceFieldConfig.environment.separator,
    service.environment ?? [],
  );

  // Only add if missing
  if (normalizedEnv.GLUESYNC_HOST) {
    return { services, updatedIds: [] };
  }

  const nextEnv = { ...normalizedEnv, GLUESYNC_HOST: gluesyncHost };
  const envArray = Object.entries(nextEnv).map(([k, v]) => `${k}=${v}`);

  const updatedService = { ...service, environment: envArray };

  return {
    services: { ...services, [chronosServiceName]: updatedService },
    updatedIds: [chronosServiceName],
  };
};

export default addGluesyncHostToChronos;
