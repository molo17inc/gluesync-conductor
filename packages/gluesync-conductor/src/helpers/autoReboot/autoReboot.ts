import { spawn } from 'node:child_process';
import autoRebootWindows from './autoRebootWindows';
import autoRebootLinux from './autorebootLinux';
import { disableUpdateMode } from '../../plugins/apiBlockerAsUpdating';

const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string;
    serviceName: string;
    helperImage: string;
    log: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;

export const spawnAsync = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts: Readonly<{ cwd?: string }> = {},
): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
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
        disableUpdateMode();

        resolve(true);
      } else {
        reject(new Error(`process exited with code ${code}`));
      }
    });
  });

export const autoReboot: AutoReboot = async opts =>
  isWindows ? autoRebootWindows(opts) : autoRebootLinux(opts);
