import { spawnAsync } from '../autoReboot/autoReboot';
import {
  buildHelperScript,
  helperContainerName,
  HELPER_KIT_DIR,
  HELPER_LOG_DIR,
} from '../autoReboot/windowsHelper';
import { FULL_RESTART_HELPER_LABEL } from './fullRestartInProgress';

type RestartWindows = (
  options: Readonly<{
    hostProjectDir: string; // host path to project (as seen by the Docker daemon)
    helperImage: string; // Windows image with pwsh
  }>,
) => Promise<boolean>;

/**
 * Runs a helper Windows container (ephemeral) from inside the current
 * Windows conductor container.
 *
 * The helper is started DETACHED (`docker run -d`): it stops this conductor, and
 * an attached client would die with it, possibly taking the helper along half
 * way through. So this resolves once the helper is started, not when it is
 * done; its output goes to `.conductor/helper-logs/<name>.log` in the kit
 * folder and to `docker logs <name>`.
 *
 * This version performs a full stack refresh:
 *   docker-compose down
 *   docker-compose up -d
 *
 * No `pull`: a restart brings back the images that ran, it never updates
 * them. `up` still pulls an image that is not on the host.
 *
 * The flow is:
 *   1. This code (inside gluesync-conductor) calls `docker run -d ...`.
 *   2. `docker.exe` talks to the host Docker Engine via DOCKER_HOST=npipe:////./pipe/docker_engine.
 *   3. The host engine starts the helper container, mounting:
 *      - the host Docker pipe
 *      - the host project directory
 *   4. Inside the helper, pwsh runs:
 *        $env:BASE_PATH='<hostProjectDir>';   (the host path, never the helper's own mount point:
 *                                              compose copies it into the recreated conductor)
 *        $env:DOCKER_HOST='npipe:////./pipe/docker_engine';
 *        docker-compose down;
 *        docker-compose up -d;
 */
const restartWindows: RestartWindows = async ({
  hostProjectDir,
  helperImage,
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  // Grab the env var your compose.yml expects
  const pwd = process.env.BASE_PATH;
  if (!pwd) {
    throw new Error('PWD/BASE_PATH env var must be set');
  }

  // 1. Normalize host path: E:/ProgramFiles/Gluesync
  const hostPath = hostProjectDir.replace(/\\/g, '/').replace(/\/$/, '');

  // 2. Fixed internal path for the helper container
  const internalPath = HELPER_KIT_DIR;

  // 3. Define the explicit path to the compose file inside the helper
  const internalComposeFile = `${internalPath}/docker-compose.yml`;

  const helperName = helperContainerName('gluesync-restart-helper');

  // --- Build PowerShell command ---
  const psCommand = buildHelperScript({
    internalPath,
    name: helperName,
    preamble: [
      `$env:DOCKER_HOST='npipe:////./pipe/docker_engine'`,
      `$env:BASE_PATH='${hostPath}'`,
      `$env:PROXY_HTTP='${process.env.PROXY_HTTP ?? ''}'`,
      `$env:PROXY_HTTPS='${process.env.PROXY_HTTPS ?? ''}'`,
    ],
    steps: [
      {
        label: 'down',
        command: `docker-compose -f "${internalComposeFile}" down --remove-orphans`,
      },
      {
        label: 'up',
        command: `docker-compose -f "${internalComposeFile}" --project-directory "${hostPath}" up -d`,
      },
    ],
  });

  // --- Build docker run args ---
  const args = [
    'run',
    '-d', // detached: must outlive the conductor it stops
    '--name',
    helperName,
    // Found by a second restart request, even by the conductor this one recreates
    '--label',
    FULL_RESTART_HELPER_LABEL,
    '--user',
    'ContainerAdministrator',
    '--rm',
    '-v',
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',
    '-v',
    `${hostPath}:${internalPath}`,
    '-w',
    internalPath,
    '-e',
    `PROXY_HTTP=${process.env.PROXY_HTTP ?? ''}`,
    '-e',
    `PROXY_HTTPS=${process.env.PROXY_HTTPS ?? ''}`,
    '-e',
    `BASE_PATH=${pwd}`,
    helperImage,
    'pwsh',
    '-NoLogo',
    '-NonInteractive',
    '-Command',
    psCommand,
  ];

  console.info(`[windows-restart] docker (windows helper) ${args.join(' ')}`);

  // `docker run -d` prints the helper's container id (logged by spawnAsync)
  await spawnAsync('docker', args, { keepUpdateMode: true });
  console.info(
    `[windows-restart] helper container "${helperName}" started detached; follow it with "docker logs ${helperName}" or in ${HELPER_LOG_DIR}/${helperName}.log in the kit folder`,
  );
  return true;
};

export default restartWindows;
