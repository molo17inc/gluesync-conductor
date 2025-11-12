import { FetchAllServicesInCompose } from './fetchAllServicesInCompose.model';

const EXCLUDED_SERVICES = new Set([
  'reverse-proxy',
  'grafana',
  'prometheus',
  'portainer',
]);

const fetchAllServicesInCompose: FetchAllServicesInCompose = (
  composeJson,
  reorder = false,
): string[] => {
  if (!composeJson.services) return [];

  const services = Object.keys(composeJson.services).filter(
    id => !EXCLUDED_SERVICES.has(id),
  );

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
