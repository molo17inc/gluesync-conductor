import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { buffer } from 'node:stream/consumers';

import resolveDockerCliPath from '../resolveDockerCliPath/resolveDockerCliPath';
import { RunDockerCli } from './runDockerCli.model';

// For the swarm commands dockerode has no equivalent of (stack deploy) or that
// are simpler through the CLI (service logs). Not `spawnAsync` of autoReboot:
// that one logs as the updater, drops the output and leaves update mode. The
// CLI is spawned by absolute path, not looked up on PATH.
const runDockerCli: RunDockerCli = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(resolveDockerCliPath(), [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    // One stream for both, so the text keeps the order it was written in. It
    // is read from the start: a long log would otherwise stall the pipes.
    const merged = new PassThrough();
    const collected = buffer(merged).then(chunk => chunk.toString('utf8'));

    // The close handler reports a failure of `collected`
    collected.catch(() => undefined);

    child.stdout.pipe(merged, { end: false });
    child.stderr.pipe(merged, { end: false });

    Promise.all([finished(child.stdout), finished(child.stderr)]).then(
      () => merged.end(),
      error => merged.destroy(error),
    );

    child.on('error', reject);
    child.on('close', code => {
      collected.then(
        output => resolve({ exitCode: code ?? 1, output }),
        reject,
      );
    });
  });

export default runDockerCli;
