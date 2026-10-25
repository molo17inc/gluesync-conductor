import type { RestoreStrategy } from '../../rollbackServiceImages/rollbackServiceImages.model';

export type SwarmRestore = (namespace: string) => RestoreStrategy;
