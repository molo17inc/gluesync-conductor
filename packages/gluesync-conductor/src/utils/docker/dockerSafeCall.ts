import { getDocker, rebuildDocker } from './resilientDocker';
import { FastifyLoggerInstance } from 'fastify';
import {
  isTransientDockerConnError,
  waitForDockerDaemon,
} from '../../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';
import { getLogger } from '../logger';

export const dockerSafeCall = async <T>(
  fn: (docker: ReturnType<typeof getDocker>) => Promise<T>,
  totalTimeoutMs = 5000,
  perAttemptTimeoutMs = 800,
): Promise<T> => {
  const logger = getLogger();
  try {
    return await fn(getDocker());
  } catch (err) {
    if (isTransientDockerConnError(err)) {
      logger.warn({ err }, 'Docker pipe error, rebuilding client and retrying');
      const docker = rebuildDocker();
      await waitForDockerDaemon(docker, logger, {
        totalTimeoutMs,
        perAttemptTimeoutMs,
      });
      return fn(docker);
    }
    throw err;
  }
};
