const extractImageInfo = (
  input: string,
): {
  name: string;
  tag: string | null;
} => {
  const dockerPrefix = 'molo17/';
  const gluesyncPrefix = 'gluesync-';

  // Remove 'molo17/' prefix
  const withoutKnownPrefix = input.startsWith(dockerPrefix)
    ? input.substring(dockerPrefix.length)
    : input;

  // Separate name and tag
  const [imageWithTag, tag] = withoutKnownPrefix.split(':');

  // Remove 'gluesync-' prefix if present
  const name = imageWithTag.startsWith(gluesyncPrefix)
    ? imageWithTag.substring(gluesyncPrefix.length)
    : imageWithTag;

  return {
    name,
    tag: tag || null,
  };
};

export default extractImageInfo;
