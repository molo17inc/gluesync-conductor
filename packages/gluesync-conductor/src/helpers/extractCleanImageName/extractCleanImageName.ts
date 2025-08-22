const extractCleanImageName = (input: string): string => {
  const dockerPrefix = 'molo17/';
  const gluesyncPrefix = 'gluesync-';

  // Remove 'molo17/' prefix since it's always present
  const withoutKnownPrefix = input.startsWith(dockerPrefix)
    ? input.substring(dockerPrefix.length)
    : input;

  // Extract part before colon (remove tag/version)
  const imageWithTag = withoutKnownPrefix.split(':')[0];

  // Remove 'gluesync-' prefix if present
  return imageWithTag.startsWith(gluesyncPrefix)
    ? imageWithTag.substring(gluesyncPrefix.length)
    : imageWithTag;
};

export default extractCleanImageName;
