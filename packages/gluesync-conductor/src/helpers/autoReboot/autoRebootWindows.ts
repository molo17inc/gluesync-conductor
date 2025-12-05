import { spawnAsync } from './autoReboot';

type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string; // host path to project (as seen by Docker daemon)
    serviceName: string;
    helperImage: string; // Windows image with pwsh (e.g. mcr.microsoft.com/powershell:lts-nanoserver-ltsc2019)
    log?: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;

/**
 * From inside the Windows conductor container, ask the host Docker
 * daemon (via DOCKER_HOST npipe) to run an ephemeral helper container:
 *
 *   docker run --rm \
 *     -v \\.\pipe\docker_engine:\\.\pipe\docker_engine \
 *     -v <hostProjectDir>:<hostProjectDir> \
 *     -w <hostProjectDir> \
 *     <helperImage> pwsh -NoLogo -NonInteractive -Command "<innerCmd>"
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

  // Command that will run *inside* the helper container
  const innerCmd = `
    $env:DOCKER_HOST = 'npipe:////./pipe/docker_engine';
    docker compose up -d --force-recreate ${serviceName}
  `;

  const args: ReadonlyArray<string> = [
    'run',
    '--rm',
    // give helper access to host Docker pipe
    '-v',
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',
    // mount host project dir into helper at the same path
    '-v',
    `${hostProjectDir}:${hostProjectDir}`,
    // run compose from that directory
    '-w',
    hostProjectDir,
    helperImage,
    // PowerShell Core inside the helper image
    'pwsh',
    '-NoLogo',
    '-NonInteractive',
    '-Command',
    innerCmd,
  ];

  log(`[conductor-updater] docker (windows helper) ${args.join(' ')}`);

  // This docker.exe is the CLI installed in your Windows container image,
  // which talks to the host Docker Engine via DOCKER_HOST=npipe://...
  await spawnAsync('docker', args);
  return true;
};

export default autoRebootWindows;
