import { composeServiceFieldConfig } from '../../models/composeFile.model';
import extractKeyValue from '../composeFile/extractKeyValue/extractKeyValue';
import { AddEnvToGrafana } from './addEnvToGrafana.model';

const addEnvToGrafana: AddEnvToGrafana = services => {
  const grafanaServiceName = 'grafana';

  const service = services[grafanaServiceName];
  if (!service) {
    console.log('[addEnvToGrafana] grafana service NOT found');
    return { services, updatedIds: [] };
  }

  // normalize environment array -> object
  const normalizedEnv = extractKeyValue(
    composeServiceFieldConfig.environment.separator,
    service.environment ?? [],
  );

  // Only add if missing
  if (normalizedEnv.GF_SECURITY_ALLOW_EMBEDDING) {
    return { services, updatedIds: [] };
  }

  const nextEnv = {
    ...normalizedEnv,
    GF_SECURITY_ALLOW_EMBEDDING: 'true',
  };

  const envArray = Object.entries(nextEnv).map(([k, v]) => `${k}=${v}`);

  const updatedService = {
    ...service,
    environment: envArray,
  };

  return {
    services: {
      ...services,
      [grafanaServiceName]: updatedService,
    },
    updatedIds: [grafanaServiceName],
  };
};

export default addEnvToGrafana;
