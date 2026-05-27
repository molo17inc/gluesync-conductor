import { existsSync } from 'node:fs';
import { join } from 'path';

import { spawnAsync } from './autoReboot';
import { getLogger } from '../../utils/logger';

type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string; // host path to project (as seen by the Docker daemon)
    serviceName: string;
    helperImage: string; // Windows image with pwsh
  }>,
) => Promise<boolean>;

const logger = getLogger();

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
 *        $env:BASE_PATH='<basePath>';
 *        $env:DOCKER_HOST='npipe:////./pipe/docker_engine';
 *        docker-compose up -d --force-recreate --pull always <service>
 */
const autoRebootWindows: AutoReboot = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  helperImage,
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

  // 2. Fixed internal path for the helper container (C: is safer for HCS)
  const internalPath = 'C:/update_context';

  // 3. Define the explicit path to the compose file inside the helper
  const internalComposeFile = `${internalPath}/docker-compose.yml`;

  // Optional env file: use it only when it exists in the mounted project root.
  const internalEnvFile = `${internalPath}/.env`;
  const mountedEnvFile = join(hostPath, '.env');
  const envFileArgs = existsSync(mountedEnvFile)
    ? `--env-file "${internalEnvFile}"`
    : '';

  if (!envFileArgs) {
    logger.info(
      '[conductor-updater] .env not found in mounted project root, continuing without --env-file',
    );
  }

  // --- shared proxy env (MATCH restartWindows behavior) ---
  const proxyHttp = process.env.PROXY_HTTP ?? '';
  const proxyHttps = process.env.PROXY_HTTPS ?? '';

  /**
   * We use the exact same strategy as the full restart:
   * - Mirror Host E: to Helper C:
   * - Use -f to point to the configuration file
   * - Use --project-directory to point the Engine back to the E: drive
   */
  const psCommand = [
    `$env:DOCKER_HOST='npipe:////./pipe/docker_engine'`,
    `$env:BASE_PATH='${hostPath}'`,
    `$env:PROXY_HTTP='${proxyHttp}'`,
    `$env:PROXY_HTTPS='${proxyHttps}'`,

    `docker-compose -f "${internalComposeFile}" ${envFileArgs} --project-directory "${hostPath}" pull ${serviceName}`
      .replaceAll(/\s+/g, ' ')
      .trim(),
    `docker-compose -f "${internalComposeFile}" ${envFileArgs} --project-directory "${hostPath}" up -d --force-recreate ${serviceName}`
      .replaceAll(/\s+/g, ' ')
      .trim(),
  ].join('; ');

  const args = [
    'run',
    '--rm', // Ensure helper is removed after execution
    '--user',
    'ContainerAdministrator',
    '-v',
    '\\\\.\\pipe\\docker_engine:\\\\.\\pipe\\docker_engine',

    // Mirror the E: folder (Host) to the helper's C: folder (Container)
    '-v',
    `${hostPath}:${internalPath}`,

    // Set workdir to the mount point
    '-w',
    internalPath,

    // Pass BASE_PATH environment variable
    '-e',
    `BASE_PATH=${pwd}`,
    // Pass proxy env (MATCH restartWindows)
    '-e',
    `PROXY_HTTP=${proxyHttp}`,
    '-e',
    `PROXY_HTTPS=${proxyHttps}`,

    helperImage,
    'pwsh',
    '-NoLogo',
    '-NonInteractive',
    '-Command',
    psCommand,
  ];

  logger.info(
    `[conductor-updater] Rebooting service "${serviceName}" on drive ${hostPath[0]}:`,
  );
  await spawnAsync('docker', args);
  return true;
};

export default autoRebootWindows;
