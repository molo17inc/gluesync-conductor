export const conductorLabels = ['service_id', 'type'] as const;

export type ConductorLabels = (typeof conductorLabels)[number];

export const conductorServiceTypes = ['agent', 'module', 'core-hub'] as const;

export type ConductorServiceTypes = (typeof conductorServiceTypes)[number];

export const releaseChannelTypes = ['alpha', 'beta', 'ga'] as const;

export type ReleaseChannelTypes = (typeof releaseChannelTypes)[number];

export const containerActions = [
  'kill',
  'pull',
  'remove',
  'removeNetwork',
  'restart',
  'start',
  'stop',
  'update',
  'undeploy',
] as const;

export type ContainerActions = (typeof containerActions)[number];
