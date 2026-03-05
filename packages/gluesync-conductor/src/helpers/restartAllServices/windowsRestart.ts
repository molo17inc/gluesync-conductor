import path from 'path';
import { spawnAsync } from '../autoReboot/autoReboot';

type RestartWindows = (
  options: Readonly<{
    hostProjectDir: string; // host path to project (as seen by the Docker daemon)
    helperImage: string; // Windows image with pwsh
    log?: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;

/**
 * Runs a helper Windows container (ephemeral) from inside the current
 * Windows conductor container.
 *
 * This version performs a full stack refresh:
 *   docker-compose pull
 *   docker-compose down
 *   docker-compose up -d
 *
 * The flow is:
 *   1. This code (inside gluesync-conductor) calls `docker run ...`.
 *   2. `docker.exe` talks to the host Docker Engine via DOCKER_HOST=npipe:////./pipe/docker_engine.
 *   3. The host engine starts the helper container, mounting:
 *      - the host Docker pipe
 *      - the host project directory
 *   4. Inside the helper, pwsh runs:
 *        $env:BASE_PATH='<basePath>';
 *        $env:DOCKER_HOST='npipe:////./pipe/docker_engine';
 *        docker-compose pull;
 *        docker-compose down;
 *        docker-compose up -d;
 */
const restartWindows: RestartWindows = async ({
  hostProjectDir,
  helperImage,
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  // Ensure absolute host path
  const absHostProjectDir = path.win32.resolve(hostProjectDir);

  // Grab the env var your compose.yml expects
  const pwd = process.env.BASE_PATH;
  if (!pwd) {
    throw new Error('PWD/BASE_PATH env var must be set');
  }

  // PowerShell command inside helper
  const psCommand =
    `$env:BASE_PATH='${pwd}'; ` +
    `$env:DOCKER_HOST='npipe:////./pipe/docker_engine'; ` +
    `docker-compose pull; ` +
    `docker-compose down --remove-orphans; ` +
    `docker-compose up -d`;

  const args = [
    'run',
    '-v',
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',
    '--rm',
    '-v',
    `${absHostProjectDir}:${absHostProjectDir}`,
    '-w',
    absHostProjectDir,
    '-e',
    `BASE_PATH=${pwd}`, // propagate to helper
    helperImage,
    'pwsh',
    '-NoLogo',
    '-NonInteractive',
    '-Command',
    psCommand,
  ];

  log(`[conductor-updater] docker (windows helper) ${args.join(' ')}`);
  await spawnAsync('docker', args);
  return true;
};

export default restartWindows;
