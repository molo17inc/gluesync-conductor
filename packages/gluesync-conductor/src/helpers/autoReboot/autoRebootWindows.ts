import { spawnAsync } from './autoReboot';

type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string;
    serviceName: string;
    helperImage: string;
    log?: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;

/**
 * Runs a helper container on Windows that performs:
 *   docker compose up -d --force-recreate <service>
 */
const autoRebootWindows: AutoReboot = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  helperImage = 'docker:28', // image with Docker CLI + compose plugin
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  // Inner PowerShell command: set DOCKER_HOST to Windows pipe, then run compose
  const innerCmd = `
    $env:DOCKER_HOST = 'npipe:////./pipe/docker_engine';
    docker compose up -d --force-recreate ${serviceName}
  `;

  const args: ReadonlyArray<string> = [
    'run',
    '--rm',
    // mount host Docker engine pipe into helper
    '-v',
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',
    // mount project directory
    '-v',
    `${hostProjectDir}:${hostProjectDir}`,
    // set working directory
    '-w',
    hostProjectDir,
    helperImage,
    'powershell',
    '-NoLogo',
    '-NonInteractive',
    '-Command',
    innerCmd,
  ];

  log(`[conductor-updater] docker (windows helper) ${args.join(' ')}`);

  await spawnAsync('docker', args);
  return true;
};

export default autoRebootWindows;
