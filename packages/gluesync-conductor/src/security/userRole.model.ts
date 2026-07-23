import type { UserRole } from './userRole';

export type ParseRole = (value: string | undefined | null) => UserRole | null;

export type CanManage = (role: UserRole) => boolean;

export type CanControl = (role: UserRole) => boolean;

export type CanModifyConfiguration = (role: UserRole) => boolean;
