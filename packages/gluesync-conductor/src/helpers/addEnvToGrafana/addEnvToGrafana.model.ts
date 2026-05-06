import { RawComposeService } from '../../models/composeFile.model';

export type AddEnvToGrafanaResult = {
  services: Readonly<Record<string, RawComposeService>>;
  updatedIds: ReadonlyArray<string>;
};

export type AddEnvToGrafana = (
  services: Readonly<Record<string, RawComposeService>>,
) => AddEnvToGrafanaResult;
