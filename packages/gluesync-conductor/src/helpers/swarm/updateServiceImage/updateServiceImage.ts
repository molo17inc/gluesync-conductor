import type Docker from 'dockerode';

import { getLogger } from '../../../utils/logger';
import getService from '../getService/getService';
import stripImageDigest from '../stripImageDigest/stripImageDigest';
import updateServiceSpec from '../updateServiceSpec/updateServiceSpec';
import { UpdateServiceImage } from './updateServiceImage.model';

const NANOSECONDS_PER_SECOND = 1_000_000_000;
// How long Swarm watches the new tasks before it calls the update good
export const MIN_UPDATE_MONITOR_NS = 15 * NANOSECONDS_PER_SECOND;

/**
 * Rolling out a new image. The update is made to roll itself back: a new task
 * that fails inside the monitor period makes Swarm return to the previous
 * spec, which is what keeps a bad image from taking the service down.
 *
 * Swarm rolls every spec change out, so a service already on the image, with
 * the rollback settings in place, is left alone and no API call is made.
 */
const updateServiceImage: UpdateServiceImage = async (
  docker,
  fullName,
  image,
) => {
  const current = await getService(docker, fullName);

  if (
    current.image === stripImageDigest(image) &&
    current.spec.UpdateConfig?.FailureAction === 'rollback' &&
    (current.spec.UpdateConfig.Monitor ?? 0) >= MIN_UPDATE_MONITOR_NS
  ) {
    return current;
  }

  const before = await updateServiceSpec(docker, fullName, spec => ({
    ...spec,
    TaskTemplate: {
      ...spec.TaskTemplate,
      ContainerSpec: {
        ...(spec.TaskTemplate as Docker.ContainerTaskSpec | undefined)
          ?.ContainerSpec,
        Image: image,
      },
    },
    UpdateConfig: {
      Parallelism: 1,
      Order: 'stop-first',
      ...spec.UpdateConfig,
      FailureAction: 'rollback',
      Monitor: Math.max(spec.UpdateConfig?.Monitor ?? 0, MIN_UPDATE_MONITOR_NS),
    },
  }));

  getLogger().info(
    { service: fullName, from: before.image, to: image },
    '[swarm] updating service image',
  );

  return before;
};

export default updateServiceImage;
