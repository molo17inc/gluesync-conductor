import { getLogger } from '../../utils/logger';
import { WaitForContainerReady } from './WaitForContainerReady.model';

/**
 * Wait for a container to be running and healthy (if health check exists)
 */
const waitForContainerReady: WaitForContainerReady = async (
  docker,
  containerName,
  maxRetries = 10,
  delayMs = 1000,
) => {
  const logger = getLogger();

  const delay = (ms: number): Promise<void> =>
    new Promise(resolve => {
      setTimeout(resolve, ms);
    });

  const checkContainerStatus = async (
    attempt: number,
  ): Promise<{ ready: boolean; shouldRetry: boolean }> => {
    try {
      const container = docker.getContainer(containerName);
      const inspect = await container.inspect();

      const isRunning = inspect.State.Running;
      const health = inspect.State.Health?.Status;

      if (!isRunning) {
        logger.debug(
          { container: containerName, attempt: attempt + 1 },
          `Container not running yet, retrying...`,
        );
        return { ready: false, shouldRetry: true };
      }

      // If container has health check, wait for it to be healthy
      if (health) {
        if (health === 'healthy') {
          logger.info(
            { container: containerName, attempts: attempt + 1 },
            `Container is running and healthy`,
          );
          return { ready: true, shouldRetry: false };
        }
        logger.debug(
          { container: containerName, health, attempt: attempt + 1 },
          `Container running but health status: ${health}, retrying...`,
        );
        return { ready: false, shouldRetry: true };
      }

      // No health check, just verify it's running
      logger.info(
        { container: containerName, attempts: attempt + 1 },
        `Container is running (no health check)`,
      );
      return { ready: true, shouldRetry: false };
    } catch (err) {
      logger.debug(
        { container: containerName, attempt: attempt + 1, error: err },
        `Error checking container status, retrying...`,
      );
      return { ready: false, shouldRetry: true };
    }
  };

  // Create array of attempts [0, 1, 2, ..., maxRetries-1]
  const attempts = Array.from({ length: maxRetries }, (_, i) => i);

  const result = await attempts.reduce(
    async (previousPromise, attempt) => {
      const previous = await previousPromise;

      // Early exit if already ready
      if (previous.ready) {
        return previous;
      }

      // Add delay between attempts (except first)
      if (attempt > 0) {
        await delay(delayMs);
      }

      const status = await checkContainerStatus(attempt);
      return status;
    },
    Promise.resolve({ ready: false, shouldRetry: true }) as Promise<{
      ready: boolean;
      shouldRetry: boolean;
    }>,
  );

  if (!result.ready) {
    throw new Error(
      `Container ${containerName} did not become ready after ${maxRetries} attempts`,
    );
  }
};

export default waitForContainerReady;
