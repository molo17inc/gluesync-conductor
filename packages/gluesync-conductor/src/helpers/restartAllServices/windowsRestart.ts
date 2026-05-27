import { spawnAsync } from '../autoReboot/autoReboot';

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
  const internalPath = 'C:/update_context';

  // 3. Define the explicit path to the compose file inside the helper
  const internalComposeFile = `${internalPath}/docker-compose.yml`;

  // --- Build PowerShell command ---
  const psCommand = [
    `$env:DOCKER_HOST='npipe:////./pipe/docker_engine'`,
    `$env:BASE_PATH='${internalPath}'`,

    `$env:PROXY_HTTP='${process.env.PROXY_HTTP ?? ''}'`,
    `$env:PROXY_HTTPS='${process.env.PROXY_HTTPS ?? ''}'`,

    `docker-compose -f "${internalComposeFile}" pull`,
    `docker-compose -f "${internalComposeFile}" down --remove-orphans`,
    `docker-compose -f "${internalComposeFile}" --project-directory "${hostPath}" up -d`,
  ].join('; ');

  // --- Build docker run args ---
  const args = [
    'run',
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

  await spawnAsync('docker', args);
  return true;
};

export default restartWindows;
