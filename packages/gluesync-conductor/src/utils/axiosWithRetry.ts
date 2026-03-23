import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { getLogger } from './logger';
import { AxiosWithRetry } from './axisWithRetry.model';

const logger = getLogger();

/**
 * Parses the proxy string from process.env (e.g., "http://user:pass@1.2.3.4:8080")
 * into an Axios-compatible object.
 */
const getProxyConfig = () => {
  // LOOK HERE: Updated to use your custom names
  const proxyUrl = process.env.PROXY_HTTPS || process.env.PROXY_HTTP;

  if (!proxyUrl) {
    return undefined;
  }

  try {
    const url = new URL(proxyUrl);
    return {
      protocol: url.protocol.replace(':', ''),
      host: url.hostname,
      // Fallback to standard ports if not specified in the URL
      port: parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80),
      auth: url.username
        ? {
            username: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
          }
        : undefined,
    };
  } catch (e) {
    logger.error({ proxyUrl }, 'Failed to parse proxy URL from environment');
    return undefined;
  }
};

const proxyConfig = getProxyConfig();

const axiosWithRetry: AxiosWithRetry = async (url, options = {}) => {
  const { timeout = 5000, retries = 3, backoffMs = 300 } = options;

  const attemptRequest = async (attempt: number): Promise<any> => {
    try {
      // Check if the current URL should skip the proxy (NO_PROXY logic)
      const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
      const shouldSkipProxy = noProxy
        .split(',')
        .some(host => url.includes(host.trim()));

      const config: AxiosRequestConfig = {
        timeout,
        proxy: shouldSkipProxy ? false : proxyConfig,
      };

      const response = await axios.get(url, config);
      return response.data;
    } catch (err) {
      const error = err as AxiosError;

      logger.warn(
        {
          url,
          attempt,
          usingCustomProxy: !!proxyConfig,
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

        // Clean, frontend-safe error
        throw new Error('Network request failed');
      }

      const delay = backoffMs * 2 ** (attempt - 1);

      await new Promise<void>(resolve => {
        setTimeout(resolve, delay);
      });
      return attemptRequest(attempt + 1);
    }
  };

  return attemptRequest(1);
};

export default axiosWithRetry;
