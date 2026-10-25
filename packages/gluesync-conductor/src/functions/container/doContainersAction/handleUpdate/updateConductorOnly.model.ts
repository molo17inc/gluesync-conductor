import { RawComposeFile } from '../../../../models/composeFile.model';

export interface ConductorInfo {
  id: string;
  availableVersion: string | null;
}

export interface UpdateConductorOnlyResult {
  id: string;
  results: PromiseSettledResult<any>[];
}

export type UpdateConductorOnlyOptions = Readonly<{
  // Docker Swarm replaces the task itself: no update mode, no watchdog
  swarm?: boolean;
}>;

export type UpdateConductorOnly = (
  action: (id: string) => Promise<any>,
  conductorInfo: Readonly<ConductorInfo>,
  composeJson: RawComposeFile,
  options?: UpdateConductorOnlyOptions,
) => Promise<UpdateConductorOnlyResult>;
