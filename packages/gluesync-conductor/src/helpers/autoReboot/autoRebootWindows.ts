import path from 'path';
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
  helperImage = 'molo17/docker-helper:28.0.0-win-nanoserver-ltsc2019-develop',
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

  const networkName =
    process.env.WINDOWS_NETWORK_NAME || 'gluesync-windows_gluesync-windows-net';

  // PowerShell command inside helper
  const psCommand =
    `$env:BASE_PATH='${pwd}'; ` +
    `$env:DOCKER_HOST='npipe:////./pipe/docker_engine'; ` +
    `docker-compose up -d --force-recreate --pull always ${serviceName}`;

  const args = [
    'run',
    '--network',
    networkName,
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

export default autoRebootWindows;
