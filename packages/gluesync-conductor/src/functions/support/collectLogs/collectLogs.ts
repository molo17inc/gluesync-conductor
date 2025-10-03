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

    // Very light email sanity check (should match your script’s check)
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      reply.code(400).send({ success: false, error: 'invalid email format' });
      return;
    }

    // Absolute path to the script in the container
    const scriptPath = './script.sh';

    // Build a safe command by avoiding shell interpolation issues.
    // Prefer execFileSync when script path is known; but request was for execSync:
    // Use quoting to minimize injection risk and pass args positionally.
    const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const cmd = `${quoted(scriptPath)} ${quoted(ticketId)} ${quoted(email)} 2>&1`; // merge stderr→stdout
    const stdout = execFileSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: '/bin/bash',
      env: process.env,
      timeout: 60_000,
    });
    console.log('>>>>>>>>>>> cmd', stdout);

    reply.code(200).send({
      success: true,
      exitCode: 0,
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
