import { getDocker, rebuildDocker } from './resilientDocker';
import {
  isTransientDockerConnError,
  waitForDockerDaemon,
} from '../../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';
import { getLogger } from '../logger';

const dockerSafeCall = async <T>(
  fn: (docker: Readonly<ReturnType<typeof getDocker>>) => Promise<T>,
  totalTimeoutMs: number = 5000,
  perAttemptTimeoutMs: number = 800,
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

export default dockerSafeCall;
