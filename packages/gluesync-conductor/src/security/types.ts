import type { UserRole } from './userRole';

export interface CurrentUser {
  readonly username: string;
  readonly role: UserRole;
}
