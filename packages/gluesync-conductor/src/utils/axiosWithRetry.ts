import axios, { AxiosError } from 'axios';
import { getLogger } from './logger';
import { AxiosWithRetry } from './axisWithRetry.model';

const logger = getLogger();

const axiosWithRetry: AxiosWithRetry = async (url, options = {}) => {
  const { timeout = 5000, retries = 3, backoffMs = 300 } = options;

  const attemptRequest = async (attempt: number): Promise<any> => {
    try {
      const response = await axios.get(url, { timeout });
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
