// `repo:tag@sha256:...` -> `repo:tag`. Swarm pins the image it resolved.
const stripImageDigest = (image: string): string => image.split('@')[0];

export default stripImageDigest;
