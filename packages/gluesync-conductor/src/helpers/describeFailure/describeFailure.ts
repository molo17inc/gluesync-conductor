/**
 * Human-readable text for a rejected container action. docker-compose rejects
 * with { exitCode, err, out }, our own code with Error: reading only `.err`
 * left ERROR items without any message.
 */
const describeFailure = (reason: unknown): string => {
  if (!reason) {
    return 'unknown error';
  }
  if (typeof reason === 'string') {
    return reason;
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  const r = reason as { err?: unknown; out?: unknown; message?: unknown };
  const text = [r.err, r.message, r.out].find(
    v => typeof v === 'string' && v.trim() !== '',
  );
  return typeof text === 'string' ? text.trim() : JSON.stringify(reason);
};

export default describeFailure;
