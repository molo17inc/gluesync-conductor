import type Docker from 'dockerode';

import { getLogger } from '../../../utils/logger';
import getService from '../getService/getService';
import resolveImageDigest from '../resolveImageDigest/resolveImageDigest';
import stripImageDigest from '../stripImageDigest/stripImageDigest';
import { STACK_IMAGE_LABEL, UPDATE_CONFIG_LABEL } from '../swarm.model';
import updateServiceSpec from '../updateServiceSpec/updateServiceSpec';
import { UpdateServiceImage } from './updateServiceImage.model';

const NANOSECONDS_PER_SECOND = 1_000_000_000;
// How long Swarm watches the new tasks before it calls the update good
export const MIN_UPDATE_MONITOR_NS = 15 * NANOSECONDS_PER_SECOND;

const containerImageOf = (spec: Readonly<Docker.ServiceSpec>): string =>
  (spec.TaskTemplate as Docker.ContainerTaskSpec | undefined)?.ContainerSpec
    ?.Image ?? '';

// The service's own UpdateConfig, kept for restoreUpdateConfig. A retry finds
// it already stashed and must not stash the rollback settings over it.
const stashUpdateConfig = (
  spec: Readonly<Docker.ServiceSpec>,
): Record<string, string> =>
  spec.Labels?.[UPDATE_CONFIG_LABEL] === undefined
    ? { [UPDATE_CONFIG_LABEL]: JSON.stringify(spec.UpdateConfig ?? null) }
    : {};

// `docker stack deploy` labels the service with the image of the stack file
const stackImageLabel = (
  spec: Readonly<Docker.ServiceSpec>,
  image: string,
): Record<string, string> =>
  spec.Labels?.[STACK_IMAGE_LABEL] === undefined
    ? {}
    : { [STACK_IMAGE_LABEL]: stripImageDigest(image) };

/**
 * Rolling out a new image. The update is made to roll itself back: a new task
 * that fails inside the monitor period makes Swarm return to the previous
 * spec, which is what keeps a bad image from taking the service down. The
 * service's own UpdateConfig is stashed in a label meanwhile, for
 * restoreUpdateConfig to put back once the update is done.
 *
 * The image is pinned to its registry digest and the stack image label set,
 * as `docker stack deploy` does: the next stack deploy of the same file then
 * finds the task template it would write and replaces no task.
 *
 * Swarm rolls every spec change out, so a service already on the image, with
 * the rollback settings in place, is left alone and no API call is made. One
 * already on the image keeps the reference it runs.
 */
const updateServiceImage: UpdateServiceImage = async (
  docker,
  fullName,
  image,
) => {
  const current = await getService(docker, fullName);
  const sameImage = current.image === stripImageDigest(image);

  if (
    sameImage &&
    current.spec.UpdateConfig?.FailureAction === 'rollback' &&
    (current.spec.UpdateConfig.Monitor ?? 0) >= MIN_UPDATE_MONITOR_NS
  ) {
    return current;
  }

  const resolved = sameImage
    ? undefined
    : await resolveImageDigest(docker, image);

  const before = await updateServiceSpec(docker, fullName, spec => ({
    ...spec,
    Labels: {
      ...spec.Labels,
      ...stackImageLabel(spec, image),
      ...stashUpdateConfig(spec),
    },
    TaskTemplate: {
      ...spec.TaskTemplate,
      ContainerSpec: {
        ...(spec.TaskTemplate as Docker.ContainerTaskSpec | undefined)
          ?.ContainerSpec,
        Image: resolved ?? containerImageOf(spec),
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
    { service: fullName, from: before.image, to: resolved ?? before.image },
    '[swarm] updating service image',
  );

  return before;
};

export default updateServiceImage;
