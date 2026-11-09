import { getLogger } from '../../../utils/logger';
import isTransientDockerConnError from '../../dockerode/isTransientDockerConnError/isTransientDockerConnError';
import {
  dockerHubManifest,
  isDistributionUnavailable,
} from '../../dockerHubRegistry/dockerHubManifest';
import { ResolveImageDigest } from './resolveImageDigest.model';

/**
 * What `docker stack deploy --resolve-image always` does: the manager asks the
 * registry for the digest of the tag and the service is pinned to it, so every
 * node runs the same image. A service updated with the bare tag differs from
 * what the next stack deploy writes, and Swarm would replace its tasks again.
 *
 * Like the CLI, an image whose registry cannot be asked (a local build, no
 * network) keeps its tag. A Docker API that dropped is not one of those: the
 * caller retries the whole update. An engine without `GET /distribution`
 * (Podman) is not asked: Docker Hub is, for the image's own manifest.
 */
const digestFromDockerHub = async (
  image: string,
): Promise<string | undefined> => {
  try {
    return (await dockerHubManifest(image))?.digest;
  } catch (error) {
    getLogger().warn(
      { image, error },
      '[swarm] could not ask Docker Hub for the image digest',
    );

    return undefined;
  }
};

const resolveImageDigest: ResolveImageDigest = async (docker, image) => {
  if (image.includes('@')) {
    return image;
  }

  try {
    const { Descriptor } = await docker.getImage(image).distribution();

    return Descriptor?.digest ? `${image}@${Descriptor.digest}` : image;
  } catch (error) {
    if (isTransientDockerConnError(error)) {
      throw error;
    }

    const digest = isDistributionUnavailable(error)
      ? await digestFromDockerHub(image)
      : undefined;

    if (digest) {
      return `${image}@${digest}`;
    }

    getLogger().warn(
      { image, error },
      '[swarm] could not resolve the image digest on its registry: the service is pinned to the tag',
    );

    return image;
  }
};

export default resolveImageDigest;
