import { ParseImage } from './parseImage.model';

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
      shortImageName: '',
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

  const shortImageName = imageName.replace(/^gluesync-/, '');

  return {
    registry,
    repository,
    tag,
    fullName,
    original: imageString,
    imageName,
    shortImageName,
  };
};

export default parseImage;
