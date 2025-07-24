import { ConductorLabels } from '../../../models/conductor.model';

export type GetCustomLabels = (
  labels: Record<string, string>,
) => Partial<Record<ConductorLabels, string | undefined>>;
