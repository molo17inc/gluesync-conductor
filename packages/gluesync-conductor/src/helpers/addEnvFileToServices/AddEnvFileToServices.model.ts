import { RawComposeService } from '../../models/composeFile.model';

export type AddEnvFile = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
) => {
  services: Record<string, RawComposeService>;
  updatedIds: ReadonlyArray<string>;
};
