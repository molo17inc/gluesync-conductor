import { spawn } from 'node:child_process';
import { copyFile, chmod, mkdir, access } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import path from 'node:path';
import { getLogger } from '../../utils/logger';
import { RunMigrationScript } from './runMigrationScript.model';

const runMigrationScript: RunMigrationScript = async () => {
  const logger = getLogger();

  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

  const ROOT_DIR = process.cwd();

  const ROOT_SCRIPT_PATH = isWindows
    ? path.join(ROOT_DIR, 'copy-agent-data.ps1')
    : path.join(ROOT_DIR, 'copy-agent-data.sh');

  const DATA_DIR = isWindows
    ? path.join(ROOT_DIR, 'root-folder', 'data')
    : path.join(ROOT_DIR, 'root-folder', 'data');

  const SCRIPT_PATH = isWindows
    ? path.join(DATA_DIR, 'copy-agent-data.ps1')
    : path.join(DATA_DIR, 'copy-agent-data.sh');

  const dockerComposeFilePath = isWindows
    ? path.join(ROOT_DIR, 'root-folder', 'docker-compose.yml')
    : '/opt/gluesync-conductor/root-folder/docker-compose.yml';

  try {
    await access(ROOT_SCRIPT_PATH);

    await mkdir(DATA_DIR, { recursive: true });

    await copyFile(ROOT_SCRIPT_PATH, SCRIPT_PATH);

    if (!isWindows) {
      await chmod(SCRIPT_PATH, 0o755);
    }

    logger.info(
      { SCRIPT_PATH },
      'Migration script copied/replaced successfully',
    );
  } catch (err) {
    logger.error(
      { err, ROOT_SCRIPT_PATH, SCRIPT_PATH },
      'Failed to copy migration script',
    );

    return {
      success: false,
      error: 'Failed to copy migration script',
    };
  }

  try {
    const command = isWindows ? 'pwsh.exe' : '/bin/bash';

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
      : [SCRIPT_PATH, dockerComposeFilePath];

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });

    child.on('error', err => {
      logger.error({ err }, 'Failed to spawn migration script');
    });

    const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
      buffer(child.stdout),
      buffer(child.stderr),
      new Promise<number>(resolve => {
        child.on('close', code => resolve(code ?? 1));
      }),
    ]);

    const stdoutText = stdoutBuf.toString('utf8');
    const stderrText = stderrBuf.toString('utf8');

    stdoutText
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach(line => {
        logger.debug({ line }, 'stdout');
      });

    stderrText
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach(line => {
        logger.debug({ line }, 'stderr');
      });

    if (exitCode === 0) {
      return {
        success: true,
        data: stdoutText.trim(),
      };
    }

    return {
      success: false,
      error: `Migration script failed with exit code ${exitCode}`,
      details: [stdoutText, stderrText].filter(Boolean).join('\n').trim(),
    };
  } catch (err) {
    logger.error({ err }, 'Internal error running migration script');

    return {
      success: false,
      error: 'Internal server error',
    };
  }
};

export default runMigrationScript;
