import { getLogger } from '../../utils/logger';
import { spawnAsync } from '../autoReboot/autoReboot';
import { getDocker } from '../../utils/docker/getDocker';
import { helperSocketEnvArgs } from '../containerRuntime/composeEnv';
import { HELPER_IMAGE_28 } from '../containerRuntime/helperImages';
import {
  ENGINE_SOCKET_IN_CONTAINER,
  resolveHostSocketPath,
} from '../containerRuntime/hostSocketPath';

type RestartLinux = (
  options: Readonly<{
    hostProjectDir: string;
    helperImage?: string; // image with docker CLI + compose plugin
  }>,
) => Promise<boolean>;

/**
 * Runs a helper container that performs:
 *   docker compose pull
 *   docker compose down
 *   docker compose up -d
 *
 * Automatically detects whether the system has `docker compose` or `docker-compose`.
 * Fully functional style: no `let` or `for`.
 */
const restartLinux: RestartLinux = async ({
  hostProjectDir,
  helperImage = HELPER_IMAGE_28,
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }
  const logger = getLogger();
  const composeCandidates = ['docker compose', 'docker-compose'] as const;

  const composeCmd = await composeCandidates.reduce<Promise<string | null>>(
    async (accPromise, candidate) => {
      const acc = await accPromise;
      if (acc) {
        return acc;
      } // already found
      try {
        await spawnAsync('sh', ['-c', `${candidate} version >/dev/null 2>&1`]);
        logger.info(`[conductor-updater] Using ${candidate}`);
        return candidate;
      } catch {
        return null;
      }
    },
    Promise.resolve(null),
  );

  if (!composeCmd) {
    throw new Error(
      '[conductor-updater] ERROR: No docker compose or docker-compose found',
    );
  }

  const innerCmd = [
    `${composeCmd} pull`,
    `${composeCmd} down --remove-orphans`,
    `${composeCmd} up -d`,
  ].join(' && ');

  // The `-v` source is resolved by the HOST engine (see autorebootLinux)
  const docker = getDocker();
  const hostSocket = await resolveHostSocketPath(docker);

  const args: ReadonlyArray<string> = [
    'run',
    '--rm',
    '--security-opt',
    'label=disable',
    '-v',
    `${hostSocket}:${ENGINE_SOCKET_IN_CONTAINER}`,
    '-v',
    `${hostProjectDir}:${hostProjectDir}`,
    '-w',
    hostProjectDir,
    ...(await helperSocketEnvArgs(docker)),
    helperImage,
    'sh',
    '-c',
    innerCmd,
  ];

  logger.info(`[linux-restart] docker ${args.join(' ')}`);

  await spawnAsync('docker', args);
  return true;
};

export default restartLinux;
