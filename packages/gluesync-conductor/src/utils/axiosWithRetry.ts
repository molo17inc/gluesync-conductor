import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getLogger } from './logger';
import { AxiosWithRetry, AxiosRequestOptions } from './axisWithRetry.model';

const logger = getLogger();

const getProxyConfig = (): string | undefined => {
  const proxyUrl = process.env.PROXY_HTTPS || process.env.PROXY_HTTP;

  logger.info({ proxyUrl }, 'Proxy URL from env');

  if (!proxyUrl) {
    logger.info('No proxy URL found, using direct connection');
    return undefined;
  }

  try {
    const url = new URL(proxyUrl);

    const proxyObj = {
      host: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80),
      auth: url.username
        ? {
            username: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
          }
        : undefined,
    };

    logger.info({ proxyObj }, 'Parsed proxy config');

    return proxyUrl;
  } catch (e: any) {
    logger.error(
      { proxyUrl, error: e.message },
      'Failed to parse proxy URL - falling back to direct',
    );

    return undefined;
  }
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
    } catch (err) {
      const error = err as AxiosError;

      logger.warn(
        {
          url,
          attempt,
          message: error.message,
          status: error.response?.status,
        },
        '[axiosWithRetry] request failed',
      );

      if (attempt >= retries + 1) {
        logger.error(
          { url, attempts: attempt },
          '[axiosWithRetry] giving up after max retries',
        );

        throw new Error('Network request failed');
      }

      const delay = backoffMs * 2 ** (attempt - 1);

      logger.info(
        { url, attempt, delay },
        '[axiosWithRetry] retrying after delay',
      );

      await sleep(delay);

      return attemptRequest(attempt + 1);
    }
  };

  logger.info({ url, retries, timeout }, '[axiosWithRetry] called');

  return attemptRequest(1);
};

export default axiosWithRetry;
