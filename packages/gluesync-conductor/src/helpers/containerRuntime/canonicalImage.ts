// Docker keeps an image as it was written (`molo17/x:1`, `busybox:1.36`);
// Podman reports it fully qualified (`docker.io/molo17/x:1`,
// `docker.io/library/busybox:1.36`). The compose file always has the short
// form, so every comparison goes through the short form.

const DOCKER_HUB_HOSTS: ReadonlyArray<string> = [
  'docker.io/',
  'index.docker.io/',
  'registry-1.docker.io/',
];

const LIBRARY = 'library/';

/**
 * `docker.io/molo17/x:1` -> `molo17/x:1`; `docker.io/library/busybox:1` ->
 * `busybox:1`. Any other registry, and a reference that is already short, come
 * back untouched. The tag and the digest are never altered.
 */
export const canonicalImageName = (image: string): string => {
  const host = DOCKER_HUB_HOSTS.find(prefix => image.startsWith(prefix));
  const withoutHost = host ? image.slice(host.length) : image;

  // `library/` only names an official image when nothing else follows the name
  return withoutHost.startsWith(LIBRARY) &&
    !withoutHost.slice(LIBRARY.length).split(/[:@]/)[0].includes('/')
    ? withoutHost.slice(LIBRARY.length)
    : withoutHost;
};

const namesRegistry = (firstSegment: string): boolean =>
  firstSegment.includes('.') ||
  firstSegment.includes(':') ||
  firstSegment === 'localhost';

/**
 * The fully qualified form of a Docker Hub image, as Podman names it:
 * `busybox:1` -> `docker.io/library/busybox:1`, `molo17/x:1` ->
 * `docker.io/molo17/x:1`. An image of another registry is returned as it is.
 */
export const qualifiedImageName = (image: string): string => {
  const canonical = canonicalImageName(image);
  const segments = canonical.split('/');

  if (segments.length > 1 && namesRegistry(segments[0])) {
    return canonical;
  }

  return segments.length === 1
    ? `docker.io/${LIBRARY}${canonical}`
    : `docker.io/${canonical}`;
};

/** Both spellings of an image, for an engine call that must match either. */
export const imageNameVariants = (image: string): ReadonlyArray<string> =>
  // An interpolated name (`${REGISTRY}/x:1`) is not an image yet
  image.includes('$')
    ? [image]
    : [
        ...new Set([
          image,
          canonicalImageName(image),
          qualifiedImageName(image),
        ]),
      ];

/** Whether two references name the same image, whichever way each is spelt. */
export const isSameImage = (a: string, b: string): boolean =>
  canonicalImageName(a) === canonicalImageName(b);
