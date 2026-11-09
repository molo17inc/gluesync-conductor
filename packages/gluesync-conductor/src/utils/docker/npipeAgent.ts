import http from 'node:http';
import net from 'node:net';
import { getLogger } from '../logger';

type Connect = (options: Readonly<{ path: string }>) => net.Socket;
type Callback = (
  error: Readonly<Error> | null,
  socket?: Readonly<net.Socket>,
) => void;

export type NpipeRetryPolicy = Readonly<{
  maxAttempts: number;
  firstDelayMs: number;
  maxDelayMs: number;
}>;

// 25, 50, 100, 200, 400, 400, 400 ms: about 1.6 s over 8 attempts
export const DEFAULT_RETRY_POLICY: NpipeRetryPolicy = {
  maxAttempts: 8,
  firstDelayMs: 25,
  maxDelayMs: 400,
};

// With every instance of the pipe busy, Windows reports the connect as ENOENT
// through node (EBUSY on some builds): only then is another try worth it
const isPipeBusy = (error: Readonly<Error>): boolean => {
  const { code } = error as NodeJS.ErrnoException;
  return code === 'ENOENT' || code === 'EBUSY';
};

/**
 * Opens a connection to the named pipe, trying again while the engine's pipe
 * has no free instance. Only the connect is retried: an error on a socket that
 * had connected is the request's to handle.
 */
export const connectToPipe = (
  connect: Connect,
  path: string,
  callback: Callback,
  policy: NpipeRetryPolicy = DEFAULT_RETRY_POLICY,
  attempt = 1,
): void => {
  const socket = connect({ path });

  // eslint-disable-next-line functional/no-let -- set once the socket connects
  let connected = false;

  socket.once('connect', () => {
    connected = true;
    callback(null, socket);
  });

  socket.once('error', error => {
    if (connected) {
      return;
    }

    socket.destroy();

    if (!isPipeBusy(error) || attempt >= policy.maxAttempts) {
      callback(error);
      return;
    }

    const delay = Math.min(
      policy.firstDelayMs * 2 ** (attempt - 1),
      policy.maxDelayMs,
    );

    getLogger().debug(
      { path, attempt, delay, code: (error as NodeJS.ErrnoException).code },
      '[docker] named pipe busy: connecting again',
    );

    setTimeout(
      () => connectToPipe(connect, path, callback, policy, attempt + 1),
      delay,
    );
  });
};

/**
 * HTTP agent for the Docker Engine's Windows named pipe. Many connections
 * opened at once find every pipe instance busy and fail with ENOENT, so the
 * connect is retried with a short backoff. Keep-alive stays off, as with
 * dockerode's default agent.
 */
export const createNpipeAgent = (
  connect: Connect = net.connect,
  policy: NpipeRetryPolicy = DEFAULT_RETRY_POLICY,
): http.Agent =>
  Object.assign(new http.Agent(), {
    // Agent.createSocket hands this an `oncreate` callback and copies a
    // request's socketPath to `path`; returning nothing means the socket
    // arrives through the callback
    createConnection: (
      options: Readonly<{ path?: string; socketPath?: string }>,
      callback: Callback,
    ): undefined => {
      connectToPipe(
        connect,
        (options.path ?? options.socketPath) as string,
        callback,
        policy,
      );
      return undefined;
    },
  });
