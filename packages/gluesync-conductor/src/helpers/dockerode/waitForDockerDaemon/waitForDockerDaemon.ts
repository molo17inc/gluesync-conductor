import type Dockerode from 'dockerode';

export type LoggerLike = {
  warn: (obj: any, msg?: string) => void;
};

export type WaitForDockerDaemonOptions = Readonly<{
  totalTimeoutMs?: number;
  perAttemptTimeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}>;

const sleep = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout after ${ms}ms`));
      }, ms);
    }),
  ]);

export const isTransientDockerConnError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const e = err as any;

  const code = String(e.code ?? '');
  const errno = String(e.errno ?? '');
  const message = String(e.message ?? '');

  // Windows named pipe not ready is commonly ENOENT / errno -4058
  if (code === 'ENOENT' || errno === '-4058') {
    return true;
  }

  if (
    code === 'ENONET' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT'
  ) {
    return true;
  }

  // Fallback: error text contains the pipe path
  if (
    message.includes('//./pipe/docker_engine') ||
    message.includes('\\\\.\\pipe\\docker_engine')
  ) {
    return true;
  }

  return false;
};

/**
 * Wait until the Docker daemon responds to ping
 */
export const waitForDockerDaemon = async (
  docker: Readonly<Pick<Dockerode, 'ping'>>,
  log: Readonly<LoggerLike>,
  opts?: WaitForDockerDaemonOptions,
): Promise<void> => {
  const totalTimeoutMs = opts?.totalTimeoutMs ?? 5000;
  const perAttemptTimeoutMs = opts?.perAttemptTimeoutMs ?? 800;
  const baseDelayMs = opts?.baseDelayMs ?? 200;
  const maxDelayMs = opts?.maxDelayMs ?? 1000;

  const deadline = Date.now() + totalTimeoutMs;

  const attemptPing = async (attempt: number): Promise<void> => {
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      throw new Error(`Docker daemon not ready within ${totalTimeoutMs}ms`);
    }

    try {
      await withTimeout(
        docker.ping(),
        Math.min(perAttemptTimeoutMs, remaining),
      );
    } catch (err) {
      if (!isTransientDockerConnError(err)) {
        throw err;
      }

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
      await attemptPing(attempt + 1);
    }
  };

  return attemptPing(0);
};
