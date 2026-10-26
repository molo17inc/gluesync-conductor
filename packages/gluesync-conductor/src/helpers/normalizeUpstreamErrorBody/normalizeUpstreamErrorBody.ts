import { redactSecrets } from '../../utils/redact';

export type NormalizedUpstreamError = Readonly<{
  error: string;
  details?: string;
}> &
  Readonly<Record<string, unknown>>;

const MAX_DETAILS_LENGTH = 500;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const firstString = (first: unknown, second: unknown): string | undefined =>
  [first, second].find((value): value is string => typeof value === 'string');

const toDetails = (text: string): string | undefined => {
  const collapsed = redactSecrets(text).replace(/\s+/g, ' ').trim();

  if (collapsed === '') {
    return undefined;
  }

  return collapsed.length > MAX_DETAILS_LENGTH
    ? `${collapsed.slice(0, MAX_DETAILS_LENGTH)}…`
    : collapsed;
};

/**
 * Makes an upstream error body safe to forward in Conductor's `{ success, error, details }` shape.
 * Upstreams answer with JSON in their own shape (`{ message }`), with an HTML
 * page (a proxy or WAF), or with nothing. Spreading a string into the reply
 * produces one key per character, and a body without `error` cannot be
 * serialised against the route schemas, so both are normalised here.
 */
const normalizeUpstreamErrorBody = (
  data: unknown,
  fallbackError: string,
): NormalizedUpstreamError => {
  if (isPlainObject(data)) {
    const { error, details, message, ...rest } = data;
    const detailText = firstString(details, message);
    const normalizedDetails =
      detailText === undefined ? undefined : toDetails(detailText);

    return {
      ...rest,
      error: typeof error === 'string' ? error : fallbackError,
      ...(normalizedDetails === undefined
        ? {}
        : { details: normalizedDetails }),
    };
  }

  const details = typeof data === 'string' ? toDetails(data) : undefined;

  return {
    error: fallbackError,
    ...(details === undefined ? {} : { details }),
  };
};

export default normalizeUpstreamErrorBody;
