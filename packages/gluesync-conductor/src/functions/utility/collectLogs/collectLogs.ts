import { spawn } from 'node:child_process';
import { buffer } from 'node:stream/consumers';
import { access, constants } from 'node:fs/promises';
import { CollectLogsHandler } from './collectLogs.model';

const handler: CollectLogsHandler = async (req, reply) => {
  const { ticketId, email } = req.body as Readonly<{
    ticketId?: string;
    email?: string;
  }>;

  if (!ticketId || !email) {
    return reply
      .code(400)
      .send({ success: false, error: 'ticketId and email are required' });
  }

  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    return reply
      .code(400)
      .send({ success: false, error: 'invalid email format' });
  }

  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';
  const scriptPath = isWindows ? './collect-logs.ps1' : './collect-logs.sh';

  // Check if script exists
  try {
    await access(scriptPath, constants.F_OK);
    // Only check executable permission on Unix-like systems
    if (!isWindows) {
      await access(scriptPath, constants.X_OK);
    }
  } catch (err) {
    req.log.error(
      { err, scriptPath, isWindows },
      'script not found or not executable',
    );
    return reply.code(500).send({
      success: false,
      error: 'log collection script not available',
    });
  }

  try {
    // Prepare command based on platform
    const command = isWindows ? 'pwsh' : scriptPath;
    const args = isWindows
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-TicketId',
          ticketId,
          '-Email',
          email,
          '-CleanAfterUpload',
        ]
      : ['-t', ticketId, '-e', email, '--clean-after-upload'];

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    // Stream per-line logs as chunks arrive
    const logLines = (
      chunk: Buffer,
      label: 'script stdout' | 'script stderr',
    ) => {
      const str = chunk.toString('utf8');
      str.split(/\r?\n/).forEach(line => {
        if (line) req.log.debug({ line }, label);
      });
    };

    child.stdout.on('data', (chunk: Buffer) =>
      logLines(chunk, 'script stdout'),
    );
    child.stderr.on('data', (chunk: Buffer) =>
      logLines(chunk, 'script stderr'),
    );

    child.on('error', err => {
      req.log.error({ err }, 'script spawn error');
      return reply
        .code(500)
        .send({ success: false, error: 'failed to start script' });
    });

    // Collect full stdout/stderr buffers in parallel
    const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
      buffer(child.stdout),
      buffer(child.stderr),
      new Promise<number>(resolve => {
        child.on('close', code => resolve(code ?? 1));
      }),
    ]);

    const stdout = stdoutBuf.toString('utf8');
    const stderr = stderrBuf.toString('utf8');

    const extractLastLine = (text: string): string =>
      text.trim().split(/\r?\n/).filter(Boolean).pop() ?? 'Unknown error';

    if (exitCode === 0) {
      return reply.code(200).send({
        success: true,
        output: stdout,
      });
    }

    return reply.code(500).send({
      success: false,
      error: `Script failed with exit code ${exitCode}`,
      details: extractLastLine(stderr || stdout),
    });
  } catch (err) {
    req.log.error({ err }, 'failed to run script');
    return reply
      .code(500)
      .send({ success: false, error: 'internal server error' });
  }
};

export default handler;
