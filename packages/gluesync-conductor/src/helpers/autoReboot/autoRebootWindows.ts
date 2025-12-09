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
 *        docker compose up -d --force-recreate <service>
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

  // Single, explicit command string passed to pwsh -Command
  // Use a script block to ensure the entire command is treated as one unit
  const innerCmd = `& { $env:DOCKER_HOST='npipe:////./pipe/docker_engine'; docker compose up -d --force-recreate ${serviceName} }`;

  const args: ReadonlyArray<string> = [
    'run',
    '--rm',
    // Give helper access to the host Docker named pipe
    '-v',
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',
    // Mount host project directory into helper at the same path
    '-v',
    `${hostProjectDir}:${hostProjectDir}`,
    // Run from that directory so docker compose picks up the right context
    '-w',
    hostProjectDir,
    helperImage,
    // Use PowerShell Core inside the helper image
    'pwsh',
    '-NoLogo',
    '-NonInteractive',
    '-Command',
    innerCmd, // must be a single, non-empty argument after -Command
  ];

  log(`[conductor-updater] docker (windows helper) ${args.join(' ')}`);

  // docker.exe is installed in your Windows container and uses DOCKER_HOST=npipe://...
  await spawnAsync('docker', args);
  return true;
};

export default autoRebootWindows;
