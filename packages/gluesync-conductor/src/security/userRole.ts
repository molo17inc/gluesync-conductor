export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  MANAGER = 'MANAGER',
  MONITOR = 'MONITOR',
  VIEWER = 'VIEWER',
  EXTERNAL_MODULE = 'EXTERNAL_MODULE',
}

export function parseRole(value: string | undefined | null): UserRole | null {
  if (!value) {
    return null;
  }
  const validRoles = Object.values(UserRole) as string[];
  if (validRoles.includes(value)) {
    return value as UserRole;
  }
  return null;
}

export function canManageSchedules(role: UserRole): boolean {
  return (
    role === UserRole.SUPER_ADMIN ||
    role === UserRole.MANAGER ||
    role === UserRole.EXTERNAL_MODULE
  );
}

export function canControlSchedules(role: UserRole): boolean {
  return (
    role === UserRole.SUPER_ADMIN ||
    role === UserRole.MANAGER ||
    role === UserRole.MONITOR ||
    role === UserRole.EXTERNAL_MODULE
  );
}

export function canModifyConfiguration(role: UserRole): boolean {
  return role === UserRole.SUPER_ADMIN || role === UserRole.MANAGER;
}
