import { RawComposeService } from '../../models/composeFile.model';

export type AddStackMountToCoreHubResult = {
  services: Readonly<Record<string, RawComposeService>>;
  updatedIds: ReadonlyArray<string>;
};

export type AddStackMountToCoreHub = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
  isWindows: boolean,
) => AddStackMountToCoreHubResult;
