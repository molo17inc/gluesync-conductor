import {
  releaseChannelTypes,
  ReleaseChannelTypes,
} from '../../models/conductor.model';

const normalizeReleaseChannel = (
  value?: string,
): ReleaseChannelTypes | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.toLowerCase();

  return releaseChannelTypes.includes(normalized as ReleaseChannelTypes)
    ? (normalized as ReleaseChannelTypes)
    : undefined;
};

export default normalizeReleaseChannel;
