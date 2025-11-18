// dockerUpdater.mjs (or .js with "type": "module")
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
 * Runs an ephemeral helper container that performs:
 *   docker compose pull <service>
 *   docker compose up -d <service>
 */
export const runSelfUpdate: RunSelfUpdate = async ({
  hostProjectDir,
  serviceName = 'gluesync-conductor',
  log = msg => console.log(msg),
}) => {
  if (!hostProjectDir) {
    throw new Error('hostProjectDir is required');
  }

  // log(`[docker-updater] updating ${serviceName} (cwd=${hostProjectDir})`);

  // console.log('>>>>>>>>>> down');

  // await spawnAsync('docker', ['compose', 'down', serviceName], {
  //   cwd: hostProjectDir,
  // });
  // console.log('>>>>>>>>>> pull');

  // await spawnAsync('docker', ['compose', 'pull', serviceName], {
  //   cwd: hostProjectDir,
  // });
  // console.log('>>>>>>>>>> up');

  // await spawnAsync(
  //   'docker',
  //   ['compose', 'up', '-d', '--force-recreate', serviceName],
  //   { cwd: hostProjectDir },
  // );

  log(`[docker-updater] updating ${serviceName} (cwd=${hostProjectDir})`);

  await spawnAsync('docker', ['compose', 'down', serviceName], {
    cwd: hostProjectDir,
  });
  await spawnAsync('docker', ['compose', 'rm', '-f', serviceName], {
    cwd: hostProjectDir,
  });
  await spawnAsync(
    'docker',
    ['rmi', `${hostProjectDir.split('/').pop()}-${serviceName}:latest`],
    { cwd: hostProjectDir },
  ).catch(() => {
    log('[docker-updater] no synthetic image to remove');
  });
  await spawnAsync('docker', ['compose', 'pull', serviceName], {
    cwd: hostProjectDir,
  });
  await spawnAsync(
    'docker',
    ['compose', 'up', '-d', '--force-recreate', serviceName],
    { cwd: hostProjectDir },
  );

  return true;
};
