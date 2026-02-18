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
    } catch (err) {
      // Non‑transient error → fail immediately
      if (!isTransientDockerConnError(err)) {
        throw err;
      }

      // Transient → retry with exponential backoff
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const cappedDelay = Math.min(delay, Math.max(0, deadline - Date.now()));

      log.warn(
        {
          attempt: attempt + 1,
          delayMs: cappedDelay,
          remainingMs: deadline - Date.now(),
          code: (err as any)?.code,
          errno: (err as any)?.errno,
          message: (err as any)?.message,
        },
        'Docker not ready yet; retrying ping',
      );

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
