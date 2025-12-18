// addGluesyncHostToAgents.ts
import { RawComposeService } from '../../models/composeFile.model';

export type AddGluesyncHostToAgentsResult = {
  services: Readonly<Record<string, RawComposeService>>;
  updatedIds: ReadonlyArray<string>;
};

export type AddGluesyncHostToAgents = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
  gluesyncHost: string,
) => AddGluesyncHostToAgentsResult;
