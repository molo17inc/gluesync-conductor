import runDockerCli from '../runDockerCli/runDockerCli';
import { ServiceLogs } from './serviceLogs.model';

const LOGS_TIMEOUT_MS = 300_000;

// Logs of every task of the service, on every node, which `docker logs` on one
// node cannot give. Only a manager can ask.
const serviceLogs: ServiceLogs = async (fullName, sinceHours, tail) => {
  const { exitCode, output } = await runDockerCli(
    [
      'service',
      'logs',
      '--no-trunc',
      '--timestamps',
      '--since',
      `${sinceHours}h`,
      ...(tail === undefined ? [] : ['--tail', String(tail)]),
      fullName,
    ],
    { timeoutMs: LOGS_TIMEOUT_MS },
  );

  if (exitCode !== 0) {
    throw new Error(
      `docker service logs ${fullName} failed (exit ${exitCode}): ${output.trim()}`,
    );
  }

  return output;
};

export default serviceLogs;
