import { spawnAsync } from '../autoReboot/autoReboot';

type RestartLinux = (
  options: Readonly<{
    hostProjectDir: string;
    helperImage: string; // image with docker CLI + compose plugin
    log?: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;

/**
 * Runs a helper container that performs:
 *   docker compose pull
 *   docker compose down
 *   docker compose up -d
 *
 * This is the Linux equivalent of the Windows full restart helper.
 */
const restartLinux: RestartLinux = async ({
  hostProjectDir,
  helperImage = 'docker:28',
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  const innerCmd = [
    'docker compose pull',
    'docker compose down',
    'docker compose up -d',
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
