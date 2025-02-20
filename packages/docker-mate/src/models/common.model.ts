export type SuccessResponse<T> = Readonly<{
  success: true;
  data: T;
}>;

export type ErrorResponse = Readonly<{
  success: false;
  errorMessage: string;
}>;
