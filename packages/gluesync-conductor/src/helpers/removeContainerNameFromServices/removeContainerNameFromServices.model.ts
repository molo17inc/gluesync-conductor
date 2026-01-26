import { RawComposeService } from '../../models/composeFile.model';

export type RemoveContainerNameFromServices = (
  composeJson: Readonly<{
    services?: Readonly<Record<string, RawComposeService>>;
  }>,
  serviceIds: ReadonlyArray<string>,
) => {
  cleanedServices: Record<string, RawComposeService>;
  removedContainerNameIds: ReadonlyArray<string>;
};
