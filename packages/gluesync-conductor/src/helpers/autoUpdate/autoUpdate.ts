import { spawn } from 'node:child_process';
import { RunSelfUpdate } from './autoUpdate.model';

/**
 * Spawns a process and resolves when it exits.
 */
export const spawnAsync = (
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', data => {
      console.log(`[docker-updater] stdout: ${data.toString().trimEnd()}`);
    });

    child.stderr.on('data', data => {
      console.log(`[docker-updater] stderr: ${data.toString().trimEnd()}`);
    });

    child.on('error', err => {
      console.log(`[docker-updater] error: ${err.message}`);
      reject(err);
    });

    child.on('close', code => {
      if (code === 0) {
        console.log('[docker-updater] process completed');
        resolve(true);
      } else {
        reject(new Error(`process exited with code ${code}`));
      }
    });
  });

/**
 * Runs a helper container that performs:
 *   docker compose pull <service>
 *   docker compose up -d --force-recreate <service>
 */
export const runSelfUpdate: RunSelfUpdate = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  helperImage = 'docker:24', // image with docker CLI + compose plugin
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  const innerCmd = [
    `docker compose pull ${serviceName}`,
    `docker compose up -d --force-recreate ${serviceName}`,
  ].join(' && ');

  const args = [
    'run',
    '--rm',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${hostProjectDir}:${hostProjectDir}`, // mount at same absolute path
    '-w',
    hostProjectDir, // set working dir to same path
    helperImage,
    'sh',
    '-c',
    innerCmd,
  ];

  log(`[docker-updater] docker ${args.join(' ')}`);

  await spawnAsync('docker', args);
  return true;
};
