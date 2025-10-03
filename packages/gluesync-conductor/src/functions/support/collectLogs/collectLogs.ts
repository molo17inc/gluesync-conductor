import { execFileSync } from 'node:child_process';
import { CollectLogsHandler } from './collectLogs.model';

const handler: CollectLogsHandler = async (req, reply) => {
  try {
    const { ticketId, email } = req.body;

    if (!ticketId || !email) {
      reply.code(400).send({
        success: false,
        error: 'ticketId and email are required',
      });
      return;
    }

    // Very light email sanity check
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      reply.code(400).send({ success: false, error: 'invalid email format' });
      return;
    }

    // Absolute path to the script in the container
    const scriptPath = './script.sh';

    const stdout = execFileSync(scriptPath, ['-t', ticketId, '-e', email], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      timeout: 60_000,
    });

    reply.code(200).send({
      success: true,
      output: stdout,
    });
  } catch (err: any) {
    // execSync throws on non-zero exit; err.status is the exit code; err.stdout/err.stderr available
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
    const message =
      typeof err?.message === 'string' ? err.message : 'Script failed';

    reply.code(500).send({
      success: false,
      error: message,
      details: `${stdout}${stderr}`,
    });
  }
};

export default handler;
