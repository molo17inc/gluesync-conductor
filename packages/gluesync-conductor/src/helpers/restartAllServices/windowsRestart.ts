import fs from 'fs';
import path from 'path';
import { spawnAsync } from '../autoReboot/autoReboot';

type RestartWindows = (
  options: Readonly<{
    hostProjectDir: string; // host path to project (as seen by the Docker daemon)
    helperImage: string; // Windows image with pwsh
    log?: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;

/**
 * Runs a helper Windows container (ephemeral) from inside the current
 * Windows conductor container.
 *
 * This version performs a full stack refresh:
 *   docker-compose pull
 *   docker-compose down
 *   docker-compose up -d
 *
 * The flow is:
 *   1. This code (inside gluesync-conductor) calls `docker run ...`.
 *   2. `docker.exe` talks to the host Docker Engine via DOCKER_HOST=npipe:////./pipe/docker_engine.
 *   3. The host engine starts the helper container, mounting:
 *      - the host Docker pipe
 *      - the host project directory
 *   4. Inside the helper, pwsh runs:
 *        $env:BASE_PATH='<basePath>';
 *        $env:DOCKER_HOST='npipe:////./pipe/docker_engine';
 *        docker-compose pull;
 *        docker-compose down;
 *        docker-compose up -d;
 */
const restartWindows: RestartWindows = async ({
  hostProjectDir,
  helperImage,
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  // Grab the env var your compose.yml expects
  const pwd = process.env.BASE_PATH;
  if (!pwd) {
    throw new Error('PWD/BASE_PATH env var must be set');
  }

  // 1. Normalize host path: E:/ProgramFiles/Gluesync
  const hostPath = hostProjectDir.replace(/\\/g, '/').replace(/\/$/, '');

  // 2. Fixed internal path for the helper container
  const internalPath = 'C:/update_context';

  // 3. Define the explicit path to the compose file inside the helper
  const internalComposeFile = `${internalPath}/docker-compose.yml`;

  // automatically use .env if present in root folder
  const internalEnvFile = `${internalPath}/.env`;

  // --- 1. Read host .env file manually ---
  const envFilePaths = [
    path.join(hostProjectDir, '.env'),
    'C:/opt/gluesync-conductor/root-folder/.env',
  ];

  const envVars = envFilePaths
    .filter(fs.existsSync)
    .flatMap(filePath => fs.readFileSync(filePath, 'utf-8').split(/\r?\n/))
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [key, ...rest] = line.split('=');
      return [key.trim(), rest.join('=').trim()] as const;
    })
    .reduce<Record<string, string>>(
      (acc, [key, value]) => ({ ...acc, [key]: value }),
      {},
    );

  // Merge BASE_PATH so it is always available
  const finalEnvVars = { ...envVars, BASE_PATH: pwd };

  // --- Build PowerShell command ---
  const psCommand = [
    `$env:DOCKER_HOST='npipe:////./pipe/docker_engine'`,
    `$env:BASE_PATH='${hostPath}'`,
    `docker-compose -f "${internalComposeFile}" --env-file "${internalEnvFile}" pull`,
    `docker-compose -f "${internalComposeFile}" --env-file "${internalEnvFile}" down --remove-orphans`,
    `docker-compose -f "${internalComposeFile}" --env-file "${internalEnvFile}" --project-directory "${hostPath}" up -d`,
  ].join('; ');

  // --- Build docker run args ---
  const args = [
    'run',
    '--rm',
    '--user',
    'ContainerAdministrator',
    '-v',
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',
    '-v',
    `${hostPath}:${internalPath}`,
    '-w',
    internalPath,
    // Inject all environment variables including BASE_PATH
    ...Object.entries(finalEnvVars).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    helperImage,
    'pwsh',
    '-NoLogo',
    '-NonInteractive',
    '-Command',
    psCommand,
  ];

  log(`[conductor-updater] docker (windows helper) ${args.join(' ')}`);
  await spawnAsync('docker', args);
  return true;
};

export default restartWindows;
