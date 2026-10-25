import { getLogger } from '../../utils/logger';
import {
  InstallShutdownHandlers,
  ShutdownSignal,
} from './installShutdownHandlers.model';

const SIGNALS: ReadonlyArray<ShutdownSignal> = ['SIGTERM', 'SIGINT'];

// Docker's default grace period is 10s: leave room to exit before the SIGKILL
const DEFAULT_TIMEOUT_MS = 8000;

const TIMED_OUT = Symbol('timed out');

const installShutdownHandlers: InstallShutdownHandlers = (
  server,
  exit,
  { timeoutMs = DEFAULT_TIMEOUT_MS, subscribe = process.on.bind(process) } = {},
) => {
  // eslint-disable-next-line functional/no-let -- set once, by the first signal
  let shuttingDown = false;

  const shutdown = async (signal: ShutdownSignal): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    // eslint-disable-next-line functional/immutable-data
    shuttingDown = true;

    const logger = getLogger();
    logger.info({ signal }, '[shutdown] signal received, closing the server');

    // eslint-disable-next-line functional/no-let -- cleared once the race is over
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const outcome = await Promise.race([
        Promise.resolve(server.close()),
        new Promise<typeof TIMED_OUT>(resolve => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        }),
      ]);

      if (outcome === TIMED_OUT) {
        logger.warn(
          { timeoutMs },
          '[shutdown] server did not close in time, exiting anyway',
        );
      } else {
        logger.info('[shutdown] server closed');
      }
      clearTimeout(timer);
      exit(0);
    } catch (error) {
      clearTimeout(timer);
      logger.error({ error }, '[shutdown] closing the server failed');
      exit(1);
    }
  };

  SIGNALS.forEach(signal => subscribe(signal, shutdown));

  return shutdown;
};

export default installShutdownHandlers;
