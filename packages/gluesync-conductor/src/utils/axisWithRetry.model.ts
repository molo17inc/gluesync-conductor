export type AxiosRetryOptions = Readonly<{
  timeout?: number;
  retries?: number;
  backoffMs?: number;
}>;

export type AxiosRequestOptions = AxiosRetryOptions &
  Readonly<{
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'PROPFIND';
    headers?: Record<string, string>;
    data?: any;
  }>;

export type AxiosWithRetry = <T>(
  url: string,
  options?: AxiosRequestOptions,
) => Promise<T>;
