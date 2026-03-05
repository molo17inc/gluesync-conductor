// addGluesyncHostToAgents.ts
import { RawComposeService } from '../../models/composeFile.model';

export type AddGluesyncHostToChronos = (
  services: Record<string, RawComposeService>,
  gluesyncHost: string,
) => {
  services: Record<string, any>;
  updatedIds: ReadonlyArray<string>;
};
