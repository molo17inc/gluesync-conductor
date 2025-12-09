import { spawnAsync } from './autoReboot';

type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string; // host path to project (as seen by the Docker daemon)
    serviceName: string;
    helperImage: string; // Windows image with pwsh (e.g. mcr.microsoft.com/powershell:lts-nanoserver-ltsc2019)
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
 *        $env:DOCKER_HOST='npipe:////./pipe/docker_engine';
 *        docker compose up -d --force-recreate --pull always <service>
 */
const autoRebootWindows: AutoReboot = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  helperImage = 'mcr.microsoft.com/powershell:lts-nanoserver-ltsc2019',
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  const args: ReadonlyArray<string> = [
    'run',
    '--rm',
    '-v',
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',
    '-v',
    `${hostProjectDir}:${hostProjectDir}`,
    '-w',
    hostProjectDir,
    helperImage,
    'pwsh',
    '-NoLogo',
    '-NonInteractive',
    '-Command',
    `$env:DOCKER_HOST='npipe:////./pipe/docker_engine'`,
    ';',
    'docker',
    'compose',
    'up',
    '-d',
    '--force-recreate',
    '--pull',
    'always',
    serviceName,
  ];

  log(`[conductor-updater] docker (windows helper) ${args.join(' ')}`);

  await spawnAsync('docker', args);
  return true;
};

export default autoRebootWindows;
