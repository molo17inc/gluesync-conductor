import { getDocker, rebuildDocker } from './getDocker';
import { getLogger } from '../logger';
import waitForDockerDaemon from '../../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';
import isTransientDockerConnError from '../../helpers/dockerode/isTransientDockerConnError/isTransientDockerConnError';

const dockerSafeCall = async <T>(
  fn: (docker: Readonly<ReturnType<typeof getDocker>>) => Promise<T>,
  totalTimeoutMs: number = 5000,
  perAttemptTimeoutMs: number = 800,
): Promise<T> => {
  const logger = getLogger();

  try {
    return await fn(getDocker());
  } catch (error) {
    if (isTransientDockerConnError(error)) {
      logger.warn(
        { error },
        'Docker pipe error, rebuilding client and retrying',
      );

      const docker = rebuildDocker();

      await waitForDockerDaemon(docker, logger, {
        totalTimeoutMs,
        perAttemptTimeoutMs,
      });

      return fn(docker);
    }

    throw error;
  }
};

export default dockerSafeCall;
