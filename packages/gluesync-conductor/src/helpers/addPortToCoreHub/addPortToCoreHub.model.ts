import { RawComposeService } from '../../models/composeFile.model';

export type AddPortToCoreHubResult = {
  services: Readonly<Record<string, RawComposeService>>;
  updatedIds: ReadonlyArray<string>;
};

export type AddPortToCoreHub = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
) => AddPortToCoreHubResult;
