import { ParseImage } from './parseImage.model';

// Compose interpolations (`${TAG:-2.3.0}`, `${A:-${B}}`, `$TAG`) hold colons,
// dots and slashes that are not image separators. They are blanked, keeping
// the length, so positions found in the masked text slice the original.
const maskInterpolations = (text: string): string => {
  const withoutBraced = text.replace(/\$\{[^${}]*\}/g, m =>
    'x'.repeat(m.length),
  );

  return withoutBraced === text
    ? text.replace(/\$[A-Za-z_]\w*/g, m => 'x'.repeat(m.length))
    : maskInterpolations(withoutBraced);
};

/**
 * Parses a Docker image string into its components.
 *
 * Example:
 * ```ts
 * Input
 * parseImage('ghcr.io/org/project/gluesync-myapp:latest');
 *
 * Output
 * {
 *   registry: 'ghcr.io',
 *   repository: 'org/project/gluesync-myapp',
 *   tag: 'latest',
 *   fullName: 'ghcr.io/org/project/gluesync-myapp',
 *   original: 'ghcr.io/org/project/gluesync-myapp:latest',
 *   imageName: 'gluesync-myapp',
 *   shortImageName: 'myapp'
 * }
 * ```
 *
 * A tag that is a Compose interpolation (`image:${TAG:-2.3.0}`) comes back
 * empty with `interpolatedTag` set.
 */
const parseImage: ParseImage = imageString => {
  if (!imageString) {
    return {
      registry: '',
      repository: '',
      tag: '',
      interpolatedTag: false,
      digest: '',
      fullName: '',
      original: '',
      imageName: '',
      shortImageName: '',
    };
  }

  // Swarm pins images by digest (`repo:tag@sha256:...`): the digest is not
  // a tag, whatever follows the last colon
  const masked = maskInterpolations(imageString);
  const digestIndex = masked.indexOf('@');
  const digest = digestIndex === -1 ? '' : imageString.slice(digestIndex + 1);
  const imageWithDigestStripped =
    digestIndex === -1 ? imageString : imageString.slice(0, digestIndex);
  const maskedWithoutDigest = masked.slice(0, imageWithDigestStripped.length);

  const lastColonIndex = maskedWithoutDigest.lastIndexOf(':');
  const hasTag = lastColonIndex > maskedWithoutDigest.indexOf('/');

  const [imageWithoutTag, rawTag = ''] = hasTag
    ? [
        imageWithDigestStripped.slice(0, lastColonIndex),
        imageWithDigestStripped.slice(lastColonIndex + 1),
      ]
    : [imageWithDigestStripped];

  // The value of an interpolated tag is only known to Compose, so it is never
  // offered as a version: callers see no tag and can tell why
  const interpolatedTag =
    hasTag && rawTag !== maskedWithoutDigest.slice(lastColonIndex + 1);
  const tag = interpolatedTag ? '' : rawTag;

  const segments = imageWithoutTag.split('/');
  const firstSegment = segments[0];
  // Docker's rule: the first component names a registry only when a path
  // follows it and it holds a dot or a port, or is `localhost`. Without the
  // slash check `name:tag` would read its tag as the port of a registry.
  const maskedFirstSegment = (
    hasTag ? maskedWithoutDigest.slice(0, lastColonIndex) : maskedWithoutDigest
  ).split('/')[0];
  const isRegistry =
    segments.length > 1 &&
    (maskedFirstSegment.includes('.') ||
      maskedFirstSegment.includes(':') ||
      maskedFirstSegment === 'localhost');

  const registry = isRegistry ? firstSegment : '';
  const repository = isRegistry
    ? segments.slice(1).join('/')
    : segments.join('/');
  const fullName = registry ? `${registry}/${repository}` : repository;
  const imageName = segments[segments.length - 1];

  const shortImageName = imageName.replace(/^gluesync-/, '');

  return {
    registry,
    repository,
    tag,
    interpolatedTag,
    digest,
    fullName,
    original: imageString,
    imageName,
    shortImageName,
  };
};

export default parseImage;
