const DISK_FULL = 'not enough free disk space';

const codeOf = (reason: unknown): string | undefined => {
  const code = (reason as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

// A full or read-only disk is the cause worth naming: the raw errno text
// ("write ENOSPC") does not tell a customer what to do.
const explain = (text: string, code?: string): string => {
  if (text.toLowerCase().includes(DISK_FULL)) {
    return text;
  }
  if (
    code === 'ENOSPC' ||
    code === 'EDQUOT' ||
    /no space left on device|disk quota exceeded/i.test(text)
  ) {
    return `${DISK_FULL}: ${text}`;
  }
  if (code === 'EROFS') {
    return `read-only file system (EROFS): ${text}`;
  }
  return text;
};

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
    return explain(reason);
  }
  if (reason instanceof Error) {
    return explain(reason.message, codeOf(reason));
  }
  const r = reason as { err?: unknown; out?: unknown; message?: unknown };
  const text = [r.err, r.message, r.out].find(
    v => typeof v === 'string' && v.trim() !== '',
  );
  return typeof text === 'string'
    ? explain(text.trim(), codeOf(reason))
    : JSON.stringify(reason);
};

export default describeFailure;
