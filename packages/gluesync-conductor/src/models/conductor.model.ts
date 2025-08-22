export const conductorLabels = ['unique_id', 'versiontag', 'type'] as const;

export type ConductorLabels = (typeof conductorLabels)[number];

export const conductorServiceTypes = ['agent', 'module'] as const;

export type ConductorServiceTypes = (typeof conductorServiceTypes)[number];

export const containerActions = [
  'kill',
  'pull',
  'remove',
  'removeNetwork',
  'restart',
  'start',
  'stop',
  // 'update',
  'undeploy',
] as const;

export type ContainerActions = (typeof containerActions)[number];
