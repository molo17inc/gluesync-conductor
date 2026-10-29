export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

// Only what the shutdown needs from the Fastify instance
export type ClosableServer = Readonly<{
  close: () => PromiseLike<unknown>;
}>;

export type ShutdownSubscribe = (
  signal: ShutdownSignal,
  handler: (signal: ShutdownSignal) => void,
) => void;

export type InstallShutdownHandlersOptions = Readonly<{
  // How long to wait for the server to close before leaving anyway
  timeoutMs?: number;
  // Defaults to `process.on`; replaced by the spec
  subscribe?: ShutdownSubscribe;
}>;

/**
 * Closes the server and exits 0 on the first SIGTERM or SIGINT (Swarm and
 * `docker stop` send SIGTERM, then SIGKILL after the grace period). Later
 * signals are ignored. Returns the shutdown itself, which settles once `exit`
 * has been called.
 */
export type InstallShutdownHandlers = (
  server: ClosableServer,
  exit: (code: number) => void,
  options?: InstallShutdownHandlersOptions,
) => (signal: ShutdownSignal) => Promise<void>;
