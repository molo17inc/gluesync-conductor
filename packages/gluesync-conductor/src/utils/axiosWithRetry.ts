import { randomInt } from 'node:crypto';

import axios, { AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getLogger } from './logger';
import { AxiosWithRetry, AxiosRequestOptions } from './axisWithRetry.model';
import { describeProxyUrl, redactSecrets, RedactedProxy } from './redact';

const logger = getLogger();

const getProxyConfig = (): string | undefined => {
  const proxyUrl = process.env.PROXY_HTTPS || process.env.PROXY_HTTP;

  if (!proxyUrl) {
    logger.info('No proxy URL found, using direct connection');
    return undefined;
  }

  // Never log the raw URL: it may carry user:password.
  const proxyInfo = describeProxyUrl(proxyUrl);

  if (!proxyInfo) {
    logger.error('Failed to parse proxy URL - falling back to direct');
    return undefined;
  }

  logger.info({ proxy: proxyInfo }, 'Parsed proxy config');

  return proxyUrl;
};

const proxyUrl = getProxyConfig();

const getNoProxyHosts = (): string[] => {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';

  return noProxy
    .split(',')
    .map(h => h.trim())
    .filter(h => h.length > 0);
};

const shouldSkipProxy = (url: string): boolean => {
  try {
    const { hostname } = new URL(url);
    return getNoProxyHosts().some(host => hostname.endsWith(host));
  } catch {
    return false;
  }
};

const createHttpsAgent = (
  skipProxy: boolean,
  proxy: string | undefined,
): HttpsProxyAgent | undefined => {
  if (skipProxy || !proxy) {
    return undefined;
  }
  return new HttpsProxyAgent(proxy);
};

/**
 * The agent OTA calls use for `url` (proxy-aware, honours NO_PROXY).
 * Exposed so connectivity probes travel exactly the same path as real requests.
 */
export const getHttpsAgentFor = (url: string): HttpsProxyAgent | undefined =>
  createHttpsAgent(shouldSkipProxy(url), proxyUrl);

/** Proxy host/port with credentials stripped, or undefined when no proxy is set. */
export const getProxyInfo = (): RedactedProxy | undefined =>
  proxyUrl ? describeProxyUrl(proxyUrl) : undefined;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

export const axiosWithRetry: AxiosWithRetry = async <T>(
  url: string,
  options: AxiosRequestOptions = {},
): Promise<T> => {
  const {
    timeout = 5000,
    retries = 3,
    backoffMs = 300,
    method = 'GET',
    data,
    headers,
  } = options;

  const attemptRequest = async (attempt: number): Promise<any> => {
    logger.info({ url, attempt }, '[axiosWithRetry] attempt');

    try {
      const skipProxy = shouldSkipProxy(url);
      const httpsAgent = createHttpsAgent(skipProxy, proxyUrl);

      const config: AxiosRequestConfig = {
        url,
        method,
        data,
        headers,
        timeout,
        proxy: false,
        httpsAgent,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        responseType: method === 'PROPFIND' ? 'text' : 'json',
        validateStatus: status =>
          (status >= 200 && status < 300) || status === 207,
      };

      const response = await axios<T>(config);

      logger.info(
        { url, attempt, status: response.status },
        '[axiosWithRetry] request succeeded',
      );

      return response.data as T;
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        const axiosError = error;

        logger.warn(
          {
            url,
            attempt,
            message: redactSecrets(axiosError.message),
            status: axiosError.response?.status,
          },
          '[axiosWithRetry] request failed',
        );

        if (attempt > retries) {
          logger.error(
            { url, attempts: attempt },
            '[axiosWithRetry] giving up after max retries',
          );
          throw axiosError;
        }

        const jitter = randomInt(100);
        const delay = Math.min(15_000, backoffMs * 2 ** (attempt - 1) + jitter);

        logger.info(
          { url, attempt, delay },
          '[axiosWithRetry] retrying after delay',
        );

        await sleep(delay);

        return attemptRequest(attempt + 1);
      }

      // non-Axios Error objects
      if (error instanceof Error) {
        logger.warn(
          { url, attempt, message: error.message },
          '[axiosWithRetry] non-axios error',
        );
        throw error;
      }

      // unknown error shape
      logger.warn({ url, attempt, error }, '[axiosWithRetry] unknown error');
      throw new Error(String(error));
    }
  };

  logger.info({ url, retries, timeout }, '[axiosWithRetry] called');

  return attemptRequest(1);
};

export default axiosWithRetry;
