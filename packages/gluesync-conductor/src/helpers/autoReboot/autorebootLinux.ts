import { spawnAsync } from './autoReboot';
import { AutoReboot } from './autoReboot.model';

const autoRebootLinux: AutoReboot = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  helperImage = 'docker:28',
  log = msg => console.log(msg),
  isPodman = false,
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  const runtime = isPodman ? 'podman' : 'docker';

  const socketMount = isPodman
    ? '/run/podman/podman.sock:/var/run/docker.sock'
    : '/var/run/docker.sock:/var/run/docker.sock';

  const composeCmd = isPodman ? 'podman compose' : 'docker compose';

  const innerCmd = `${composeCmd} up -d --force-recreate ${serviceName}`;

  const args: ReadonlyArray<string> = [
    'run',
    '--rm',
    '-v',
    socketMount,
    '-v',
    `${hostProjectDir}:${hostProjectDir}`,
    '-w',
    hostProjectDir,
    helperImage,
    'sh',
    '-c',
    innerCmd,
  ];

  log(`[conductor-updater] ${runtime} ${args.join(' ')}`);

  await spawnAsync(runtime, args);
  return true;
};

export default autoRebootLinux;
