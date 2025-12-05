import { spawnAsync } from './autoReboot';

type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string;
    serviceName?: string;
    helperImage: string;
    log?: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;

const autoRebootWindows: AutoReboot = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  helperImage,
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  const psScript = [
    // talk to host engine
    `$env:DOCKER_HOST = 'npipe:////./pipe/docker_engine';`,
    // pull new image if desired
    `docker pull molo17/gluesync-conductor:0.4.4-win-nanoserver-ltsc2019;`,
    // stop & remove old container (ignore errors)
    `docker run -d ` +
      `-p 5017:1717 ` +
      `-v \\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine ` +
      `-e BASE_PATH=${hostProjectDir} ` +
      `-e GLUESYNC_HOST=gluesync-core-hub ` +
      `-e LOG_LEVEL=trace ` +
      `molo17/gluesync-conductor:0.4.4-win-nanoserver-ltsc2019;`,
  ].join(' ');

  const args: ReadonlyArray<string> = [
    'run',
    '--rm',
    // mount host Docker engine pipe into helper
    '-v',
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',
    helperImage,
    'powershell',
    '-NoLogo',
    '-NonInteractive',
    '-Command',
    psScript,
  ];

  log(`[conductor-updater] docker (windows helper) ${args.join(' ')}`);

  await spawnAsync('docker', args);
  return true;
};

export default autoRebootWindows;
