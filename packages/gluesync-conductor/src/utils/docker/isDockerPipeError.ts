const isDockerPipeError = (err: unknown): boolean => {
  if (!err) {
    return false;
  }

  const msg =
    err instanceof Error
      ? err.message.toLowerCase()
      : String(err).toLowerCase();

  return (
    msg.includes('eof') ||
    msg.includes('pipe') ||
    msg.includes('docker_engine') ||
    msg.includes('socket hang up') ||
    msg.includes('connection reset') ||
    msg.includes('the pipe has been ended') ||
    msg.includes('bad response from docker engine') ||
    msg.includes('context deadline exceeded')
  );
};

export default isDockerPipeError;
