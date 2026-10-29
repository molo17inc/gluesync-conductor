import type Docker from 'dockerode';

import { readComposeFile } from '../../composeFile/readComposeFile/readComposeFile';
import describeFailure from '../../describeFailure/describeFailure';
import type { RestoreStrategy } from '../../rollbackServiceImages/rollbackServiceImages.model';
import fingerprintSwarmServices from '../fingerprintSwarmServices/fingerprintSwarmServices';
import getService from '../getService/getService';
import getServiceTasks from '../getServiceTasks/getServiceTasks';
import restoreUpdateConfig from '../restoreUpdateConfig/restoreUpdateConfig';
import retryOnDockerOutage from '../retryOnDockerOutage/retryOnDockerOutage';
import stripImageDigest from '../stripImageDigest/stripImageDigest';
import updateServiceImage from '../updateServiceImage/updateServiceImage';
import { SwarmRestore } from './swarmRestore.model';

const POLL_MS = 2000;
// While Swarm itself is rolling the service out or back
const IN_PROGRESS_STATES: ReadonlySet<string> = new Set([
  'updating',
  'rollback_started',
]);

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

// How long a service gets to settle on the restored image, the same budget as
// the wait for an update to converge.
const settleMs = (): number => {
  const raw = Number(process.env.UPDATE_VERIFY_MAX_WAIT_SECONDS);

  return (Number.isFinite(raw) && raw >= 0 ? raw : 180) * 1000;
};

// An image with a variable in it ("${REGISTRY}/x:1") cannot be compared as written.
const comparable = (image?: string): string | undefined =>
  image && !image.includes('$') ? stripImageDigest(image) : undefined;

const isNotFound = (error: unknown): boolean =>
  (error as { statusCode?: number })?.statusCode === 404;

const imageInStackFile = async (id: string): Promise<string | undefined> =>
  (await readComposeFile({ raw: true })).services?.[id]?.image;

type Problem = Readonly<{ id: string; reason: string }>;

// Why the service is not what the stack file says: another image, a rollout
// still going, or fewer running tasks than replicas. null when it is fine.
const inspectService = async (
  docker: Readonly<Docker>,
  fullName: string,
  id: string,
  image?: string,
): Promise<Problem | null> => {
  const service = await getService(docker, fullName);
  const expected = comparable(image);

  if (expected && service.image !== expected) {
    return {
      id,
      reason: `${id} runs ${service.image} but the stack file says ${expected}`,
    };
  }
  if (service.updateState && IN_PROGRESS_STATES.has(service.updateState)) {
    return {
      id,
      reason: `${id} is still being updated (${service.updateState})`,
    };
  }

  const tasks = await getServiceTasks(docker, fullName, {
    resolveNodes: false,
  });
  const running = tasks.filter(task => task.state === 'running').length;
  const wanted = service.replicas ?? tasks.length;
  const stale = tasks.some(task => task.image !== service.image);

  return running === wanted && tasks.length === wanted && !stale
    ? null
    : {
        id,
        reason: `${id} runs ${running}/${wanted} tasks (${service.image})`,
      };
};

const swarmRestore: SwarmRestore = namespace => {
  const fullName = (id: string): string => `${namespace}_${id}`;

  const problemWith: RestoreStrategy['problemWith'] = async (
    docker,
    id,
    image,
  ) => {
    try {
      return await inspectService(docker, fullName(id), id, image);
    } catch (error) {
      return {
        id,
        reason: isNotFound(error)
          ? `${id} does not exist`
          : `${id} could not be checked: ${describeFailure(error)}`,
      };
    }
  };

  // Polls until the service is as the file says, or the budget is spent
  const settle = async (
    docker: Readonly<Docker>,
    id: string,
    image: string,
    deadline: number,
  ): Promise<string | undefined> => {
    const problem = await problemWith(docker, id, image);

    if (!problem) {
      return undefined;
    }
    if (Date.now() >= deadline) {
      return problem.reason;
    }
    await sleep(POLL_MS);

    return settle(docker, id, image, deadline);
  };

  // Puts the service on the image of the stack file (what a rollback restored
  // there) and waits for Swarm to run it. A service already on that image is
  // not written at all, so Swarm's own rollback is left as it is.
  const putOnStackImage = async (
    docker: Readonly<Docker>,
    id: string,
  ): Promise<string | undefined> => {
    const image = await imageInStackFile(id);

    if (!image) {
      return `${id} has no image in the stack file`;
    }

    await retryOnDockerOutage(docker, `restore ${id}`, () =>
      updateServiceImage(docker, fullName(id), image),
    );

    const problem = await settle(docker, id, image, Date.now() + settleMs());

    // Put back the service's own update settings, as after any good rollout
    if (!problem) {
      await retryOnDockerOutage(
        docker,
        `restore update settings of ${id}`,
        () => restoreUpdateConfig(docker, fullName(id)),
      );
    }

    return problem;
  };

  return {
    fingerprint: (docker, ids) =>
      fingerprintSwarmServices(docker, namespace, ids),
    bringUp: async (docker, id) => {
      try {
        return await putOnStackImage(docker, id);
      } catch (error) {
        return describeFailure(error);
      }
    },
    problemWith,
  };
};

export default swarmRestore;
