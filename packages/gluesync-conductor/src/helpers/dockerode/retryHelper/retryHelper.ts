import { IDockerComposeResult } from 'docker-compose';
import isTransientDockerConnError from '../../../helpers/dockerode/isTransientDockerConnError/isTransientDockerConnError';
import { RetryCmd } from './retryHelper.model';

/**
 * Determines if a Docker error should trigger retry (container conflicts + connection issues)
 */
export const shouldRetryError = (
  error: Readonly<unknown>,
  message: Readonly<string>,
): boolean => {
  if (isTransientDockerConnError(error)) {
    return true;
  }

  const lower = message.toLowerCase();
  return (
    lower.includes('conflict') &&
    lower.includes('container name') &&
    lower.includes('already in use')
  );
};

/**
 * Safe delay helper (avoids no-promise-executor-return)
 */
export const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Functional recursive retry (no loops, no let, no mutation)
 * Uses unknown to avoid eslint-plugin-functional deep type inspection.
 */
export const retryCmd: RetryCmd = (
  attempt,
  maxRetries,
  fn,
  logger,
  id,
): Promise<IDockerComposeResult> =>
  fn()
    .then(result => result as IDockerComposeResult)
    .catch(async (err: any) => {
      const message: Readonly<string> = err?.message ?? '';

      if (!shouldRetryError(err, message)) {
        throw err;
      }

      if (attempt >= maxRetries) {
        throw err;
      }

      logger.warn(
        { id, attempt, error: message },
        `Docker-compose command transient failure (attempt ${attempt}/${maxRetries}), retrying...`,
      );

      await delay(1000 ** attempt);

      return retryCmd(attempt + 1, maxRetries, fn, logger, id);
    });
