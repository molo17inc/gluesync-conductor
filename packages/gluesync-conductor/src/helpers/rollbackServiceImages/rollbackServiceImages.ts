import type Docker from 'dockerode';
import { upAll } from 'docker-compose';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import { runCmd } from '../dockerode/createActions/createActions';
import describeFailure from '../describeFailure/describeFailure';
import { getLogger } from '../../utils/logger';
import inSequence from '../../utils/inSequence';
import waitForDockerOutage from '../dockerode/waitForDockerOutage/waitForDockerOutage';
import {
  fingerprintServices,
  observeService,
} from '../serviceContainers/serviceContainers';
import type { Fingerprints } from '../serviceContainers/serviceContainers.model';
import {
  RollbackOutcome,
  RollbackServiceImages,
} from './rollbackServiceImages.model';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';
// Tries to bring a service that is still not as the compose file says: after
// that it is reported instead (a Docker that keeps failing is not looped on).
const RECONCILE_ATTEMPTS = 2;

type Rollbacks = Parameters<RollbackServiceImages>[0];
type Restore = Readonly<{
  docker: Readonly<Docker>;
  before?: Fingerprints;
  services: ReadonlyArray<string>;
}>;
type Broken = Readonly<{ id: string; reason: string }>;

// A failure here (full disk, unreadable compose) must not replace the error
// that made the update fail: it is logged and reported next to it instead.
const putImagesBack = async (
  rollbacks: Rollbacks,
): Promise<string | undefined> => {
  try {
    const compose = await readComposeFile({ raw: true });
    const services = Object.fromEntries(
      Object.entries(compose.services ?? {}).map(([id, service]) => {
        const rollback = rollbacks.find(r => r.id === id);
        return [id, rollback ? { ...service, image: rollback.image } : service];
      }),
    );
    await writeComposeFile({ ...compose, services });
    return undefined;
  } catch (error) {
    const message = describeFailure(error);
    getLogger().error(
      { error: message, services: rollbacks.map(r => r.id) },
      '[update] could not put the previous images back in the compose file',
    );
    return `compose file could not be restored: ${message}`;
  }
};

const failAll = (rollbacks: Rollbacks, error: string): RollbackOutcome[] =>
  rollbacks.map(({ id, image }) => ({ id, image, ok: false, error }));

// Resolves to the failure, if any: one service failing to come back must not
// stop the others from being tried.
const bringUp = async (id: string): Promise<string | undefined> => {
  try {
    await runCmd(upAll, id, dkrComposeFile, ['--no-deps']);
    return undefined;
  } catch (error) {
    return describeFailure(error);
  }
};

const recreate = async (
  id: string,
  image: string,
): Promise<RollbackOutcome> => {
  const failure = await bringUp(id);
  if (failure === undefined) {
    getLogger().warn({ service: id, image }, '[update] rolled back service');
    return { id, image, ok: true };
  }
  getLogger().error(
    { service: id, image, error: failure },
    '[update] rollback failed',
  );
  return { id, image, ok: false, error: failure };
};

// Resolves to why Docker did not answer within the wait budget, if it did not.
const dockerStillDown = async (
  docker: Readonly<Docker>,
): Promise<string | undefined> => {
  try {
    await waitForDockerOutage(docker);
    return undefined;
  } catch (error) {
    return describeFailure(error);
  }
};

// The services whose containers are not what they were before the update: only
// those can be on a new image. Without a "before" (or when Docker does not
// answer now) every service counts as touched.
const touchedServices = async (
  { docker, before }: Restore,
  ids: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> => {
  if (!before) {
    return new Set(ids);
  }
  try {
    const now = await fingerprintServices(docker, ids);
    return new Set(ids.filter(id => now[id] !== before[id]));
  } catch (error) {
    getLogger().warn(
      { error: describeFailure(error) },
      '[update] could not tell which services the failed update touched',
    );
    return new Set(ids);
  }
};

const imagesInCompose = async (): Promise<
  Readonly<Record<string, string | undefined>>
> => {
  const compose = await readComposeFile({ raw: true });
  return Object.fromEntries(
    Object.entries(compose.services ?? {}).map(([id, service]) => [
      id,
      service?.image,
    ]),
  );
};

// An image with a variable in it ("${REGISTRY}/x:1") cannot be compared as written.
const comparable = (image?: string): string | undefined =>
  image && !image.includes('$') ? image : undefined;

const problemWith = async (
  docker: Readonly<Docker>,
  id: string,
  image?: string,
): Promise<Broken | null> => {
  try {
    const seen = await observeService(docker, id);
    if (!seen.running) {
      return { id, reason: `${id} is not running (${seen.detail})` };
    }
    const expected = comparable(image);
    return expected && seen.image !== expected
      ? {
          id,
          reason: `${id} runs ${seen.image} but the compose file says ${expected}`,
        }
      : null;
  } catch (error) {
    return {
      id,
      reason: `${id} could not be checked: ${describeFailure(error)}`,
    };
  }
};

// The services that are stopped, half recreated or on another image than the
// compose file names (a Docker outage in the middle of an update leaves all of
// those). Anything that cannot be checked counts as broken.
const brokenServices = async (
  docker: Readonly<Docker>,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<Broken>> => {
  try {
    const images = await imagesInCompose();
    const found = await Promise.all(
      ids.map(id => problemWith(docker, id, images[id])),
    );
    return found.filter((problem): problem is Broken => problem !== null);
  } catch (error) {
    const reason = `could not be checked: ${describeFailure(error)}`;
    return ids.map(id => ({ id, reason: `${id} ${reason}` }));
  }
};

// After a rollback every service of the update set must be running what the
// compose file says. Whatever is not gets `up --no-deps` (bounded attempts);
// resolves to what is still wrong.
const reconcile = async (
  docker: Readonly<Docker>,
  ids: ReadonlyArray<string>,
  attemptsLeft: number = RECONCILE_ATTEMPTS,
): Promise<ReadonlyArray<Broken>> => {
  const broken = await brokenServices(docker, ids);
  if (broken.length === 0 || attemptsLeft === 0) {
    return broken;
  }
  getLogger().warn(
    { problems: broken.map(b => b.reason) },
    '[update] services are not as the compose file says after the rollback: starting them',
  );
  await inSequence(broken, ({ id }) => bringUp(id));
  return reconcile(docker, ids, attemptsLeft - 1);
};

// What the final check still found wrong: a rollback that looked fine is not,
// and a service that was no part of the rollback is named too.
const withProblems = (
  outcomes: ReadonlyArray<RollbackOutcome>,
  broken: ReadonlyArray<Broken>,
): ReadonlyArray<RollbackOutcome> => [
  ...outcomes.map(outcome => {
    const problem = broken.find(b => b.id === outcome.id);
    return problem
      ? {
          id: outcome.id,
          image: outcome.image,
          ok: false,
          error: outcome.error ?? problem.reason,
        }
      : outcome;
  }),
  ...broken
    .filter(b => !outcomes.some(o => o.id === b.id))
    .map(b => ({ id: b.id, image: '', ok: false, error: b.reason })),
];

const restoreContainers = async (
  rollbacks: Rollbacks,
  restore: Restore,
): Promise<ReadonlyArray<RollbackOutcome>> => {
  // The failure that triggered this is often a Docker outage: recreating
  // before it is back would only fail again and leave half-done containers.
  const down = await dockerStillDown(restore.docker);
  if (down) {
    return failAll(rollbacks, `Docker is not reachable: ${down}`);
  }

  const touched = await touchedServices(
    restore,
    rollbacks.map(r => r.id),
  );
  const outcomes = await inSequence(rollbacks, ({ id, image }) =>
    touched.has(id)
      ? recreate(id, image)
      : Promise.resolve<RollbackOutcome>({
          id,
          image,
          ok: true,
          untouched: true,
        }),
  );

  const conductor = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
  const ids = [...new Set([...restore.services, ...rollbacks.map(r => r.id)])];
  const broken = await reconcile(
    restore.docker,
    ids.filter(id => id !== conductor),
  );
  return withProblems(outcomes, broken);
};

/**
 * Puts services back on the image they had before a failed update. The compose
 * file is rewritten before images are pulled, so without this a failed pull
 * left it pointing at an image that does not exist (and the next restart of
 * that service failed). With `recreate`, the containers are brought back on the
 * old image too (for a new image that does not stay up): once Docker answers,
 * only the services the update actually touched, and then every service of the
 * update set is checked and started if it is not running what the compose file
 * says.
 */
const rollbackServiceImages: RollbackServiceImages = async (
  rollbacks,
  options,
) => {
  if (rollbacks.length === 0) {
    return [];
  }

  const failure = await putImagesBack(rollbacks);
  if (failure) {
    // Recreating now would only start the new image again.
    return failAll(rollbacks, failure);
  }

  if (!options.recreate) {
    return rollbacks.map(({ id, image }) => ({ id, image, ok: true }));
  }
  return restoreContainers(rollbacks, options);
};

export default rollbackServiceImages;
