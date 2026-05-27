import { getLogger } from '../../utils/logger';
import { spawnAsync } from './autoReboot';

type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string;
    serviceName: string;
    helperImage: string;
  }>,
) => Promise<boolean>;

const logger = getLogger();

/**
 * Runs a helper container that performs:
 *   docker compose up -d --force-recreate <service>
 */
const autoRebootLinux: AutoReboot = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  helperImage = 'docker:28', // image with docker CLI + compose plugin
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

  logger.info(`[conductor-updater] docker ${args.join(' ')}`);

  await spawnAsync('docker', args);
  return true;
};

export default autoRebootLinux;
