import type { UserRole } from './userRole';

// eslint-disable-next-line functional/no-mixed-types
export interface CurrentUser {
  readonly username: string;
  readonly role: UserRole;
}

export const createIntrospectionError = (message: string): Error => {
  const error = new Error(message);
  // eslint-disable-next-line functional/immutable-data
  error.name = 'IntrospectionError';
  return error;
};
