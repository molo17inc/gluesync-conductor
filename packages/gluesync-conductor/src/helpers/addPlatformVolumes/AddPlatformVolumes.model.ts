import { RawComposeService } from '../../models/composeFile.model';

export type AddPlatformVolumes = (
  services: Record<string, RawComposeService>,
  serviceIds: readonly string[],
  isWindows: boolean,
) => {
  services: Record<string, RawComposeService>;
  updatedIds: ReadonlyArray<string>;
};
