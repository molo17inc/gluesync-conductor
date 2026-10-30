// Images of the helper containers the Conductor starts (self update, restart of
// the whole stack). Fully qualified: Podman on RHEL-like hosts refuses a short
// name without a TTY to choose a registry, and a qualified name means the same
// image on Docker.
export const HELPER_IMAGE_CLI = 'docker.io/library/docker:cli';

export const HELPER_IMAGE_28 = 'docker.io/library/docker:28';
