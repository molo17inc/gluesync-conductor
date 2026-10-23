import type { Diagnosis } from '../diagnosis/diagnosis.model';

export type SuccessResponse<T> = Readonly<{
  success: true;
  data: T;
}>;

export type ErrorResponse = Readonly<{
  success: false;
  error: string;
  details?: string;
  /** Why the request failed and what to do; see diagnosis/diagnosis.model.ts. */
  diagnosis?: Diagnosis;
}>;

export type Require<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>;
