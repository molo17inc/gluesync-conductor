import isTransientDockerConnError from '../isTransientDockerConnError/isTransientDockerConnError';
import type { WaitForDockerDaemon } from './waitForDockerDaemon.model';

/**
 * Sleep helper
 */
const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Promise timeout wrapper
 */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout after ${ms}ms`));
      }, ms);
    }),
  ]);

/**
 * Wait until the Docker daemon responds to ping.
 * Fully cross‑platform with exponential backoff.
 */
const waitForDockerDaemon: WaitForDockerDaemon = async (docker, log, opts) => {
  const totalTimeoutMs = opts?.totalTimeoutMs ?? 15000;
  const perAttemptTimeoutMs = opts?.perAttemptTimeoutMs ?? 1500;
  const baseDelayMs = opts?.baseDelayMs ?? 500;
  const maxDelayMs = opts?.maxDelayMs ?? 2000;

  const deadline = Date.now() + totalTimeoutMs;

  const attemptPing = async (attempt: number): Promise<void> => {
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      throw new Error(`Docker daemon not ready within ${totalTimeoutMs}ms`);
    }

    const tryPing = async (): Promise<void> => {
      await withTimeout(
        docker.ping(),
        Math.min(perAttemptTimeoutMs, remaining),
      );
    };

    try {
      await tryPing();
      return undefined; // <-- fixes consistent-return
    } catch (error) {
      // Non‑transient error → fail immediately
      if (!isTransientDockerConnError(error)) {
        throw error;
      }

      // Transient → retry with exponential backoff
      const now = Date.now();
      const remainingMs = Math.max(0, deadline - now);
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const cappedDelay = Math.min(delay, remainingMs);

      // inline safe extractor for unknown error shapes
      const errInfo = (() => {
        if (error instanceof Error) {
          const anyErr = error as unknown as Record<string, unknown>;
          return {
            message: error.message,
            stack: error.stack,
            code:
              typeof anyErr.code === 'string' ? String(anyErr.code) : undefined,
            errno:
              typeof anyErr.errno === 'string' ||
              typeof anyErr.errno === 'number'
                ? anyErr.errno
                : undefined,
          };
        }

        return {
          message: typeof error === 'string' ? error : undefined,
          stack: undefined,
          code: undefined,
          errno: undefined,
        };
      })();

      log.warn(
        {
          attempt: attempt + 1,
          delayMs: cappedDelay,
          remainingMs,
          code: errInfo.code,
          errno: errInfo.errno,
          message: errInfo.message,
        },
        'Docker not ready yet; retrying ping',
      );

      // stack trace at debug level to reduce noise
      if (errInfo.stack) {
        log.debug({ stack: errInfo.stack }, 'Docker ping error stack');
      }

      if (cappedDelay <= 0) {
        throw new Error(`Docker daemon not ready within ${totalTimeoutMs}ms`);
      }

      await sleep(cappedDelay);
      return attemptPing(attempt + 1);
    }
  };

  return attemptPing(0);
};

export default waitForDockerDaemon;
