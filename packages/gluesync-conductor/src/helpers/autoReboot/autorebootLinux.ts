import { spawnAsync } from './autoReboot';

type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string;
    serviceName: string;
    helperImage: string;
    log: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;

/**
 * Runs a helper container that performs:
 *   docker compose up -d --force-recreate <service>
 */
const autoRebootLinux: AutoReboot = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  helperImage = 'docker:28', // image with docker CLI + compose plugin
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  const innerCmd = [
    `docker compose up -d --force-recreate ${serviceName}`,
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

export default autoRebootLinux;
