import { composeServiceFieldConfig } from '../../models/composeFile.model';
import { getLogger } from '../../utils/logger';
import extractKeyValue from '../composeFile/extractKeyValue/extractKeyValue';
import { AddEnvToGrafana } from './addEnvToGrafana.model';

const addEnvToGrafana: AddEnvToGrafana = services => {
  const grafanaServiceName = 'grafana';
  const logger = getLogger();

  const service = services[grafanaServiceName];
  if (!service) {
    logger.info('[addEnvToGrafana] grafana service NOT found');
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
