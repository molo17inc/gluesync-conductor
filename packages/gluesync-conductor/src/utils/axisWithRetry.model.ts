export type AxiosRetryOptions = Readonly<{
  timeout?: number;
  retries?: number;
  backoffMs?: number;
}>;

export type AxiosWithRetry = <T>(
  url: string,
  options?: AxiosRetryOptions,
) => Promise<T>;
