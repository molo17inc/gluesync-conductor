import { ParseImage } from './parseImage.model';

/**
 * Parses a Docker image string into its components.
 *
 * Example:
 * ```ts
 * Input
 * parseImage('ghcr.io/org/project/myapp:latest');
 *
 * Output
 * {
 *   registry: 'ghcr.io',
 *   repository: 'org/project/myapp',
 *   tag: 'latest',
 *   fullName: 'ghcr.io/org/project/myapp',
 *   original: 'ghcr.io/org/project/myapp:latest',
 *   imageName: 'myapp'
 * }
 * ```
 */
const parseImage: ParseImage = imageString => {
  if (!imageString) {
    return {
      registry: '',
      repository: '',
      tag: '',
      fullName: '',
      original: '',
      imageName: '',
    };
  }

  const lastColonIndex = imageString.lastIndexOf(':');
  const hasTag = lastColonIndex > imageString.indexOf('/');

  const [imageWithoutTag, tag = ''] = hasTag
    ? [
        imageString.slice(0, lastColonIndex),
        imageString.slice(lastColonIndex + 1),
      ]
    : [imageString];

  const segments = imageWithoutTag.split('/');
  const firstSegment = segments[0];
  const isRegistry = firstSegment.includes('.') || firstSegment.includes(':');

  const registry = isRegistry ? firstSegment : '';
  const repository = isRegistry
    ? segments.slice(1).join('/')
    : segments.join('/');
  const fullName = registry ? `${registry}/${repository}` : repository;
  const imageName = segments[segments.length - 1];

  return {
    registry,
    repository,
    tag,
    fullName,
    original: imageString,
    imageName,
  };
};

export default parseImage;
