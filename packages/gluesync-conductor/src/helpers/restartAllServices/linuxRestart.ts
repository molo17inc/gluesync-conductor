import { spawnAsync } from '../autoReboot/autoReboot';

type RestartLinux = (
  options: Readonly<{
    hostProjectDir: string;
    helperImage?: string; // image with docker CLI + compose plugin
    log?: (msg: Readonly<string>) => void;
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
  helperImage = 'docker:28',
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  const composeCandidates = ['docker compose', 'docker-compose'] as const;

  const composeCmd = await composeCandidates.reduce<Promise<string | null>>(
    async (accPromise, candidate) => {
      const acc = await accPromise;
      if (acc) {
        return acc;
      } // already found
      try {
        await spawnAsync('sh', ['-c', `${candidate} version >/dev/null 2>&1`]);
        log(`[conductor-updater] Using ${candidate}`);
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

  const args: ReadonlyArray<string> = [
    'run',
    '--rm',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${hostProjectDir}:${hostProjectDir}`,
    '-w',
    hostProjectDir,
    helperImage,
    'sh',
    '-c',
    innerCmd,
  ];

  log(`[conductor-updater] docker ${args.join(' ')}`);

  await spawnAsync('docker', args);
  return true;
};

export default restartLinux;
