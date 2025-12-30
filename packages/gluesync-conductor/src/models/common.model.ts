export type SuccessResponse<T> = Readonly<{
  success: true;
  data: T;
}>;

export type ErrorResponse = Readonly<{
  success: false;
  error: string;
  details?: string;
}>;

export type Require<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;
