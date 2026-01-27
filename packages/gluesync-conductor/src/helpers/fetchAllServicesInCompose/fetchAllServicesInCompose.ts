import {
  THIRD_PARTY_SERVICES,
  FetchAllServicesInCompose,
} from './fetchAllServicesInCompose.model';

const fetchAllServicesInCompose: FetchAllServicesInCompose = (
  composeJson,
  reorder = false,
  includeThirdParty = false,
) => {
  if (!composeJson.services) return [];

  const services = Object.keys(composeJson.services).filter(id => {
    if (includeThirdParty) return true;
    return !THIRD_PARTY_SERVICES.has(id);
  });

  if (!reorder) {
    return services;
  }

  const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';

  const withoutHub = services.filter(id => id !== coreHubName);
  const withoutConductor = withoutHub.filter(id => id !== 'gluesync-conductor');

  const reordered = [
    ...(services.includes(coreHubName) ? [coreHubName] : []),
    ...withoutConductor,
    ...(services.includes('gluesync-conductor') ? ['gluesync-conductor'] : []),
  ];

  return reordered;
};

export default fetchAllServicesInCompose;
