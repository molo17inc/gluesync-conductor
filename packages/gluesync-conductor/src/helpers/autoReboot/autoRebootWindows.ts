import { spawnAsync } from './autoReboot';

type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string; // host path to project (as seen by the Docker daemon)
    serviceName: string;
    helperImage: string; // Windows image with pwsh
    log?: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;

/**
 * Runs a helper Windows container (ephemeral) from inside the current
 * Windows conductor container.
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
 *        docker-compose up -d --force-recreate --pull always <service>
 */
const autoRebootWindows: AutoReboot = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  helperImage,
  log = msg => console.log(msg),
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

  // 2. Fixed internal path for the helper container (C: is safer for HCS)
  const internalPath = 'C:/update_context';

  // 3. Define the explicit path to the compose file inside the helper
  const internalComposeFile = `${internalPath}/docker-compose.yml`;

  /**
   * We use the exact same strategy as the full restart:
   * - Mirror Host E: to Helper C:
   * - Use -f to point to the configuration file
   * - Use --project-directory to point the Engine back to the E: drive
   */
  const psCommand = [
    `$env:DOCKER_HOST='npipe:////./pipe/docker_engine'`,
    `$env:BASE_PATH='${hostPath}'`,
    `docker-compose -f "${internalComposeFile}" --project-directory "${hostPath}" pull ${serviceName}`,
    `docker-compose -f "${internalComposeFile}" --project-directory "${hostPath}" up -d --force-recreate ${serviceName}`,
  ].join('; ');

  const args = [
    'run',
    '--rm', // Ensure helper is removed after execution
    '--user',
    'ContainerAdministrator',
    '-v',
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',

    // Mirror the E: folder (Host) to the helper's C: folder (Container)
    '-v',
    `${hostPath}:${internalPath}`,

    // Set workdir to the mount point
    '-w',
    internalPath,

    // Pass BASE_PATH environment variable
    '-e',
    `BASE_PATH=${hostPath}`,

    helperImage,
    'pwsh',
    '-NoLogo',
    '-NonInteractive',
    '-Command',
    psCommand,
  ];

  log(
    `[conductor-updater] Rebooting service "${serviceName}" on drive ${hostPath[0]}:`,
  );
  await spawnAsync('docker', args);
  return true;
};

export default autoRebootWindows;
