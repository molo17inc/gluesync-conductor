import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getLogger } from './logger';
import { AxiosWithRetry } from './axisWithRetry.model';

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
      { proxyUrl, error: e.message || e.message },
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
  const hosts = getNoProxyHosts();

  const matches = hosts.map(host => url.includes(host));
  const found = matches.find(match => match === true);

  return found === true;
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

const axiosWithRetry: AxiosWithRetry = async (url, options = {}) => {
  const { timeout = 5000, retries = 3, backoffMs = 300 } = options;

  const attemptRequest = async (attempt: number): Promise<any> => {
    logger.info({ url, attempt }, '[axiosWithRetry] attempt');

    try {
      const skipProxy = shouldSkipProxy(url);

      logger.info(
        { url, shouldSkipProxy: skipProxy, attempt },
        '[axiosWithRetry] proxy decision',
      );

      const httpsAgent = createHttpsAgent(skipProxy, proxyUrl);

      const config: AxiosRequestConfig = {
        timeout,
        proxy: false,
        httpsAgent,
      };

      const response = await axios.get(url, config);

      logger.info(
        { url, attempt, status: response.status },
        '[axiosWithRetry] request succeeded',
      );

      return response.data;
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
