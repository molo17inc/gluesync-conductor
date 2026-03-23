import { RawComposeService } from '../../models/composeFile.model';

export type ApplyCoreHubProductionTweaksResult = {
  services: Readonly<Record<string, RawComposeService>>;
  updatedIds: ReadonlyArray<string>;
};

export type ApplyCoreHubProductionTweaks = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
  isWindows: boolean,
) => ApplyCoreHubProductionTweaksResult;
