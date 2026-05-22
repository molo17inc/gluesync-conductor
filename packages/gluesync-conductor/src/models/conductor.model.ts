export const conductorLabels = ['service_id', 'type'] as const;

export type ConductorLabels = (typeof conductorLabels)[number];

export const conductorServiceTypes = [
  'agent',
  'module',
  'core-hub',
  'third-party',
] as const;

export type ConductorServiceTypes = (typeof conductorServiceTypes)[number];

export const releaseChannelTypes = ['alpha', 'beta', 'ga'] as const;

export type ReleaseChannelTypes = (typeof releaseChannelTypes)[number];

export const normalizeReleaseChannel = (
  value?: string,
): ReleaseChannelTypes | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase();

  return releaseChannelTypes.includes(normalized as ReleaseChannelTypes)
    ? (normalized as ReleaseChannelTypes)
    : undefined;
};

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
