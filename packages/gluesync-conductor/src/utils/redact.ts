/* eslint-disable functional/no-let, functional/no-loop-statements -- index scans: recursion would overflow the stack on long input, and each step must stay O(1) */
const SCHEME_CHAR = /^[a-z0-9+.-]$/i;
const LETTER = /^[a-z]$/i;
const WHITESPACE = /^\s$/;
const MASK = '***:***@';

// A scheme starts at the first letter of the run of scheme characters that
// ends right before `://`: true when that run has a letter.
const hasSchemeBefore = (text: string, separatorIndex: number): boolean => {
  let hasLetter = false;

  for (let index = separatorIndex - 1; index >= 0; index -= 1) {
    const char = text[index];

    if (!SCHEME_CHAR.test(char)) {
      break;
    }
    hasLetter = hasLetter || LETTER.test(char);
  }

  return hasLetter;
};

// The userinfo ends at the first `@`, provided no `/` or whitespace comes first.
// The user may be empty (`http://:token@proxy`), the password may be missing.
const findUserinfoEnd = (text: string, from: number): number => {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];

    if (char === '@') {
      return index;
    }
    if (char === '/' || WHITESPACE.test(char)) {
      return -1;
    }
  }

  return -1;
};

/**
 * Masks `user:password@` embedded in any URL found in free text
 * (axios and proxy-agent error messages can echo the proxy URL back).
 * A linear scan: every `://` is looked at once, so adversarial input cannot
 * trigger backtracking.
 */
export const redactSecrets = (text: string): string => {
  let masked = '';
  let copiedUntil = 0;
  let searchFrom = 0;

  for (;;) {
    const separator = text.indexOf('://', searchFrom);

    if (separator === -1) {
      return masked + text.slice(copiedUntil);
    }

    const userinfoEnd = hasSchemeBefore(text, separator)
      ? findUserinfoEnd(text, separator + 3)
      : -1;

    if (userinfoEnd === -1) {
      searchFrom = separator + 1;
    } else {
      masked += text.slice(copiedUntil, separator + 3) + MASK;
      copiedUntil = userinfoEnd + 1;
      searchFrom = copiedUntil;
    }
  }
};

export type RedactedProxy = Readonly<{
  host: string;
  port: number;
  authenticated: boolean;
}>;

/**
 * Reduces a proxy URL to what is safe to log or show to a user:
 * host, port and whether credentials are configured. Never the credentials.
 */
export const describeProxyUrl = (value: string): RedactedProxy | undefined => {
  try {
    const url = new URL(value);

    return {
      host: url.hostname,
      port:
        Number.parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80),
      authenticated: url.username !== '',
    };
  } catch {
    return undefined;
  }
};
