import { getLogger } from '../../../utils/logger';
import isTransientDockerConnError from '../../dockerode/isTransientDockerConnError/isTransientDockerConnError';
import { ResolveImageDigest } from './resolveImageDigest.model';

/**
 * What `docker stack deploy --resolve-image always` does: the manager asks the
 * registry for the digest of the tag and the service is pinned to it, so every
 * node runs the same image. A service updated with the bare tag differs from
 * what the next stack deploy writes, and Swarm would replace its tasks again.
 *
 * Like the CLI, an image whose registry cannot be asked (a local build, no
 * network) keeps its tag. A Docker API that dropped is not one of those: the
 * caller retries the whole update.
 */
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

    getLogger().warn(
      { image, error },
      '[swarm] could not resolve the image digest on its registry: the service is pinned to the tag',
    );

    return image;
  }
};

export default resolveImageDigest;
