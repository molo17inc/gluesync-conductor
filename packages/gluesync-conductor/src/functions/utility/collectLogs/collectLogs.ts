import { spawn } from 'node:child_process';
import { buffer } from 'node:stream/consumers';
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

  try {
    //todo check if script present
    const child = spawn('./collect-logs.sh', ['-t', ticketId, '-e', email], {
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

    if (exitCode === 0) {
      return reply.code(200).send({
        success: true,
        output: stdout,
      });
    }
    return reply.code(500).send({
      success: false,
      error: `Script failed with exit code ${exitCode}`,
      details: stderr || stdout,
    });
  } catch (err) {
    req.log.error({ err }, 'failed to run script');
    return reply
      .code(500)
      .send({ success: false, error: 'internal server error' });
  }
};

export default handler;
