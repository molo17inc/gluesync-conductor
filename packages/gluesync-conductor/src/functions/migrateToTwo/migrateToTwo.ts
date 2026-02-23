import { spawn } from 'node:child_process';
import { buffer } from 'node:stream/consumers';
import { access, constants, copyFile, chmod, mkdir } from 'node:fs/promises';
import type { MigrateToTwoHandler } from './migrateToTwo.model';

const migrateToTwoHandler: MigrateToTwoHandler = async (req, reply) => {
  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

  const ROOT_SCRIPT_PATH = isWindows
    ? 'C:\\opt\\gluesync-conductor\\copy-agent-data.ps1'
    : './copy-agent-data.sh';

  const DATA_DIR = isWindows
    ? 'C:\\opt\\gluesync-conductor\\root-folder\\data'
    : './root-folder/data';

  const SCRIPT_PATH = isWindows
    ? `${DATA_DIR}\\copy-agent-data.ps1`
    : `${DATA_DIR}/copy-agent-data.sh`;

  const dockerComposeFilePath = isWindows
    ? 'C:\\opt\\gluesync-conductor\\root-folder\\docker-compose.yml'
    : '/opt/gluesync-conductor/root-folder/docker-compose.yml';

  await mkdir(DATA_DIR, { recursive: true });

  // Copy script into data folder, replacing if it already exists
  try {
    await copyFile(ROOT_SCRIPT_PATH, SCRIPT_PATH); // overwrites by default
    if (!isWindows) {
      await chmod(SCRIPT_PATH, 0o755);
    }
    req.log.info(
      { SCRIPT_PATH },
      'Migration script copied/replaced successfully',
    );
  } catch (err) {
    req.log.error(
      { err, ROOT_SCRIPT_PATH, SCRIPT_PATH },
      'Failed to copy/replace migration script',
    );
    return reply.status(500).send({
      success: false,
      error: 'Failed to copy migration script',
    });
  }

  try {
    const command = isWindows ? 'pwsh' : SCRIPT_PATH;
    const args = isWindows
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          SCRIPT_PATH,
          '-ComposeFile',
          dockerComposeFilePath,
        ]
      : [dockerComposeFilePath];

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdoutText = '';
    let stderrText = '';

    const logLines = (chunk: Buffer, label: 'stdout' | 'stderr') => {
      const str = chunk.toString('utf8');
      if (label === 'stdout') stdoutText += str;
      else stderrText += str;

      str.split(/\r?\n/).forEach(line => {
        if (line) req.log.debug({ line }, label);
      });
    };

    child.stdout.on('data', chunk => logLines(chunk, 'stdout'));
    child.stderr.on('data', chunk => logLines(chunk, 'stderr'));

    child.on('error', err =>
      req.log.error({ err }, 'Failed to spawn migration script'),
    );

    const exitCode: number = await new Promise(resolve => {
      child.on('close', code => resolve(code ?? 1));
    });

    if (exitCode === 0) {
      return reply.status(200).send({
        success: true,
        data: stdoutText.trim(), // full stdout
      });
    }

    return reply.status(500).send({
      success: false,
      error: `Migration script failed with exit code ${exitCode}`,
      details: (stdoutText + '\n' + stderrText).trim(), // full output for context
    });
  } catch (err) {
    req.log.error({ err }, 'Internal error running migration script');
    return reply.status(500).send({
      success: false,
      error: 'Internal server error',
    });
  }
};

export default migrateToTwoHandler;
