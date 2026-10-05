const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi;

/**
 * Masks `user:password@` embedded in any URL found in free text
 * (axios and proxy-agent error messages can echo the proxy URL back).
 */
export const redactSecrets = (text: string): string =>
  text.replace(CREDENTIALS_IN_URL, '$1***:***@');

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
      port: parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80),
      authenticated: url.username !== '',
    };
  } catch {
    return undefined;
  }
};
