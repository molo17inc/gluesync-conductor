/**
 * Cross‑platform detection of transient Docker connection errors.
 * Handles:
 *  - Windows named pipe not ready
 *  - macOS/Linux unix socket not ready
 *  - Connection refused
 *  - Connection reset / EOF
 *  - Timeouts
 */
const isTransientDockerConnError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const e = err as any;
  const code = String(e.code ?? '');
  const errno = String(e.errno ?? '');
  const message = String(e.message ?? '').toLowerCase();

  // Windows named pipe not ready (ENOENT / -4058)
  if (code === 'ENOENT' || errno === '-4058') {
    return true;
  }

  // Unix socket not ready (macOS/Linux)
  if (code === 'ECONNREFUSED' || code === 'ENOENT') {
    return true;
  }

  // Common transient network/pipe errors
  if (
    code === 'ENONET' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT'
  ) {
    return true;
  }

  // Message‑based detection
  if (
    message.includes('docker.sock') ||
    message.includes('connection refused') ||
    message.includes('connection reset') ||
    message.includes('eof') ||
    message.includes('the pipe has been ended') ||
    message.includes('//./pipe/docker_engine') ||
    message.includes('\\\\.\\pipe\\docker_engine')
  ) {
    return true;
  }

  return false;
};

export default isTransientDockerConnError;
