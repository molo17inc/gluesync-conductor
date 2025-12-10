import { spawn } from 'node:child_process';
import { AutoReboot } from './AutoReboot.model';

/**
 * Spawns a process and resolves when it exits.
 */
export const spawnAsync = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts: Readonly<{ cwd?: string }> = {},
): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', data => {
      console.log(`[conductor-updater] stdout: ${data.toString().trimEnd()}`);
    });

    child.stderr.on('data', data => {
      console.log(`[conductor-updater] stderr: ${data.toString().trimEnd()}`);
    });

    child.on('error', err => {
      console.log(`[conductor-updater] error: ${err.message}`);
      reject(err);
    });

    child.on('close', code => {
      if (code === 0) {
        console.log('[conductor-updater] process completed');
        resolve(true);
      } else {
        reject(new Error(`process exited with code ${code}`));
      }
    });
  });

/**
 * Runs a helper container that performs:
 *   docker compose up -d --force-recreate <service>
 */
export const autoReboot: AutoReboot = async ({
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
