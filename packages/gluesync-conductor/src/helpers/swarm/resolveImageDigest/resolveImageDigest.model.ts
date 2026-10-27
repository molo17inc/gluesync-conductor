import type Docker from 'dockerode';

// `repo:tag` -> `repo:tag@sha256:...`, the reference as it stands on its
// registry; the image as given when the registry cannot be asked
export type ResolveImageDigest = (
  docker: Readonly<Docker>,
  image: string,
) => Promise<string>;
