import type Docker from 'dockerode';

import { LabelPrefix } from '../../models/composeFile.model';
import { getLogger } from '../../utils/logger';
import describeFailure from '../describeFailure/describeFailure';
import { chronosDataTarget } from '../disasterRecoveryCompose/disasterRecoveryCompose';
import type {
  CoreHubOwner,
  GiveChronosDataToCoreHub,
  ResolveCoreHubOwner,
} from './disasterRecoveryOwnership.model';

const LOG = '[disaster-recovery]';

// ARG USER_UID of the Core Hub image
const DEFAULT_OWNER: CoreHubOwner = { uid: 1017, gid: 1017 };

const NUMERIC_USER = /^(\d+)(?::(\d+))?$/;

/**
 * Rootless Podman with `GS_COREHUB_USERNS=keep-id:uid=1017,gid=1017` starts Core Hub as the
 * host user of the kit: the files already belong to it, and a chown to 1017 would only map to
 * a sub-uid the host user cannot read. Without it, rootless Podman is not supported here:
 * the owner set below is a sub-uid of the user namespace of the helper container.
 */
const keepsHostUser = (
  compose: Readonly<Record<string, any>>,
  coreHub: string,
): boolean =>
  Boolean(process.env.GS_COREHUB_USERNS?.trim()) ||
  String(compose.services?.[coreHub]?.userns_mode ?? '').startsWith('keep-id');

export const resolveCoreHubOwner: ResolveCoreHubOwner = async (
  docker,
  image,
) => {
  const logger = getLogger();

  if (!image) {
    return DEFAULT_OWNER;
  }

  try {
    const { Config } = await docker.getImage(image).inspect();
    const user = (Config?.User ?? '').trim();

    if (!user) {
      return DEFAULT_OWNER;
    }

    const match = NUMERIC_USER.exec(user);

    if (!match) {
      logger.warn(
        { image, user },
        `${LOG} the Core Hub image runs as "${user}", not a numeric id: using ${DEFAULT_OWNER.uid}`,
      );
      return DEFAULT_OWNER;
    }

    return { uid: Number(match[1]), gid: Number(match[2] ?? match[1]) };
  } catch (error) {
    logger.warn(
      { image, error },
      `${LOG} could not read the user of the Core Hub image: using ${DEFAULT_OWNER.uid}`,
    );
    return DEFAULT_OWNER;
  }
};

const logsOf = async (
  container: Readonly<Docker.Container>,
): Promise<string> => {
  try {
    return (await container.logs({ stdout: true, stderr: true }))
      .toString('utf8')
      .trim();
  } catch {
    return '';
  }
};

/**
 * `chown` in a short-lived container that shares the volumes of the Chronos container: it
 * reaches a bind folder or a named volume alike, as root, with no host path to work out. The
 * image is the one Chronos runs from, so nothing is pulled; its own entrypoint (the database
 * migrations) is replaced.
 */
const chownInHelper = async (
  docker: Readonly<Docker>,
  image: string,
  chronosContainer: string,
  directory: string,
  owner: CoreHubOwner,
): Promise<void> => {
  const container = await docker.createContainer({
    Image: image,
    User: '0:0',
    Entrypoint: ['chown'],
    Cmd: ['-R', `${owner.uid}:${owner.gid}`, directory],
    NetworkDisabled: true,
    HostConfig: { VolumesFrom: [chronosContainer] },
  });

  try {
    await container.start();

    const { StatusCode } = await container.wait();

    if (StatusCode !== 0) {
      throw new Error(
        `chown exited with code ${StatusCode}: ${await logsOf(container)}`,
      );
    }
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
};

export const giveChronosDataToCoreHub: GiveChronosDataToCoreHub = async (
  docker,
  compose,
  { coreHub, chronos, windows },
) => {
  const logger = getLogger();

  if (windows) {
    logger.info(
      `${LOG} Windows containers: the owner of the Chronos data is not changed`,
    );
    return;
  }

  if (keepsHostUser(compose as Record<string, any>, coreHub)) {
    logger.info(
      `${LOG} Core Hub starts as the host user (GS_COREHUB_USERNS): the owner of the Chronos data is not changed`,
    );
    return;
  }

  const services = (compose.services ?? {}) as Record<string, any>;
  const directory = chronosDataTarget(services[chronos] ?? {}, windows);
  const owner = await resolveCoreHubOwner(docker, services[coreHub]?.image);

  try {
    const [found] = await docker.listContainers({
      all: true,
      filters: { label: [`${LabelPrefix.COMPOSE}.service=${chronos}`] },
    });

    if (!found) {
      throw new Error(
        `there is no container of ${chronos} to take its data directory from`,
      );
    }

    await chownInHelper(
      docker,
      found.ImageID || found.Image,
      found.Id,
      directory,
      owner,
    );
  } catch (error) {
    logger.error(
      { error, directory, owner },
      `${LOG} could not make ${directory} of ${chronos} belong to ${owner.uid}:${owner.gid}, the user of Core Hub`,
    );
    throw new Error(
      `Could not give the Chronos data directory to Core Hub (${owner.uid}:${owner.gid}): ${describeFailure(error)}`,
    );
  }

  logger.info(
    { directory, owner },
    `${LOG} ${directory} of ${chronos} now belongs to ${owner.uid}:${owner.gid}, the user of Core Hub`,
  );
};

export default giveChronosDataToCoreHub;
