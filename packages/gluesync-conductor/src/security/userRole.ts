import type {
  CanControl,
  CanManage,
  CanModifyConfiguration,
  ParseRole,
} from './userRole.model';

export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  MANAGER = 'MANAGER',
  MONITOR = 'MONITOR',
  VIEWER = 'VIEWER',
  EXTERNAL_MODULE = 'EXTERNAL_MODULE',
}

export const parseRole: ParseRole = value => {
  if (!value) {
    return null;
  }
  const validRoles = Object.values(UserRole) as string[];
  if (validRoles.includes(value)) {
    return value as UserRole;
  }
  return null;
};

export const canManage: CanManage = role =>
  role === UserRole.SUPER_ADMIN ||
  role === UserRole.MANAGER ||
  role === UserRole.EXTERNAL_MODULE;

export const canControl: CanControl = role =>
  role === UserRole.SUPER_ADMIN ||
  role === UserRole.MANAGER ||
  role === UserRole.MONITOR ||
  role === UserRole.EXTERNAL_MODULE;

export const canModifyConfiguration: CanModifyConfiguration = role =>
  role === UserRole.SUPER_ADMIN || role === UserRole.MANAGER;
