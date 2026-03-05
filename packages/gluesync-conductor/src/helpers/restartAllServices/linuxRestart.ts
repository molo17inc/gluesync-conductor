import { spawnAsync } from '../autoReboot/autoReboot';

type RestartLinux = (
  options: Readonly<{
    hostProjectDir: string;
    helperImage: string;
    log?: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;

const restartLinux: RestartLinux = async ({
  hostProjectDir,
  helperImage = 'docker:28',
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  // Try docker compose first, fallback to docker-compose
  const composeCmd = `
    if docker compose version >/dev/null 2>&1; then
      echo "[conductor-updater] Using docker compose";
      docker compose pull &&
      docker compose down --remove-orphans &&
      docker compose up -d;
    elif docker-compose version >/dev/null 2>&1; then
      echo "[conductor-updater] Using docker-compose";
      docker-compose pull &&
      docker-compose down --remove-orphans &&
      docker-compose up -d;
    else
      echo "[conductor-updater] ERROR: No docker compose or docker-compose found" >&2;
      exit 1;
    fi
  `;

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
    composeCmd,
  ];

  log(`[conductor-updater] docker ${args.join(' ')}`);

  await spawnAsync('docker', args);
  return true;
};

export default restartLinux;
