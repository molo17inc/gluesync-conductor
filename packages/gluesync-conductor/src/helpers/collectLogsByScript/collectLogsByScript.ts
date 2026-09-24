import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import { join } from 'node:path';
import { CollectLogsByScript } from './collectLogsByScript.model';
import { getLogger } from '../../utils/logger';

const MAX_OUTPUT_LINES = 10;

const logger = getLogger();

const sanitizeLines = (text: string): ReadonlyArray<string> =>
  text
    .split(/\r?\n/)
    .map(line => line.replace(/[^\t -~]/g, '').trimEnd())
    .filter(line => line.length > 0);

const formatOutput = (text: string): string => {
  const lines = sanitizeLines(text);

  if (lines.length === 0) {
    return 'Unknown error';
  }

  if (lines.length <= MAX_OUTPUT_LINES) {
    return lines.join('\n');
  }

  return `${lines.slice(0, MAX_OUTPUT_LINES).join('\n')}\n...`;
};

const resolveLegacyScriptPath = async (
  isWindows: boolean,
): Promise<string | null> => {
  const scriptName = isWindows ? 'collect-logs.ps1' : 'collect-logs.sh';

  const candidates = [
    join(process.cwd(), scriptName),
    join(process.cwd(), 'build', scriptName),
    isWindows
      ? `C:\\opt\\gluesync-conductor\\${scriptName}`
      : `/opt/gluesync-conductor/${scriptName}`,
    isWindows
      ? `C:\\opt\\gluesync-conductor\\root-folder\\${scriptName}`
      : `/opt/gluesync-conductor/root-folder/${scriptName}`,
  ];

  const checks = candidates.map(candidate => {
    const check = isWindows
      ? access(candidate, constants.F_OK)
      : Promise.all([
          access(candidate, constants.F_OK),
          access(candidate, constants.X_OK),
        ]);
    return check.then(() => candidate).catch(() => null);
  });

  const results = await Promise.all(checks);

  return (results.find(result => result !== null) as string) ?? null;
};

const collectLogsByScript: CollectLogsByScript = async options => {
  const { ticketId, email } = options;

  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

  const scriptPath = await resolveLegacyScriptPath(isWindows);

  if (!scriptPath) {
    return {
      success: false,
      output: 'Legacy collect logs script not found or not executable.',
    };
  }

  logger?.warn({ scriptPath }, 'Falling back to legacy collect logs script');

  try {
    const command = isWindows ? 'pwsh' : scriptPath;

    const args = isWindows
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-Ticket',
          ticketId,
          '-Email',
          email,
          '-CleanAfterUpload',
        ]
      : ['-t', ticketId, '-e', email, '--clean-after-upload'];

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      shell: false,
    });

    const logLines = (
      chunk: Buffer,
      label: 'legacy stdout' | 'legacy stderr',
    ): void => {
      const str = chunk.toString('utf8');

      str.split(/\r?\n/).forEach(line => {
        if (line) {
          logger?.debug({ line }, label);
        }
      });
    };

    child.stdout?.on('data', (chunk: Buffer) =>
      logLines(chunk, 'legacy stdout'),
    );

    child.stderr?.on('data', (chunk: Buffer) =>
      logLines(chunk, 'legacy stderr'),
    );

    const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
      buffer(child.stdout),
      buffer(child.stderr),
      new Promise<number>(resolve => {
        child.on('close', code => resolve(code ?? 1));
      }),
    ]);

    const stdout = stdoutBuf.toString('utf8');
    const stderr = stderrBuf.toString('utf8');

    if (exitCode === 0) {
      logger?.info('Legacy collect logs script completed successfully');

      return {
        success: true,
        output: formatOutput(stdout),
      };
    }

    logger?.error(
      {
        exitCode,
        stderr: formatOutput(stderr),
      },
      'Legacy collect logs script failed',
    );

    return {
      success: false,
      output: formatOutput(stderr || stdout),
    };
  } catch (error) {
    logger?.error({ error }, 'Failed to execute legacy collect logs script');

    return {
      success: false,
      output: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

export default collectLogsByScript;
