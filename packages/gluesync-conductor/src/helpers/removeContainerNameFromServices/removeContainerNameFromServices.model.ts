import { RawComposeService } from '../../models/composeFile.model';

export type RemoveContainerNameFromServices = (
  composeJson: { services?: Record<string, RawComposeService> },
  serviceIds: ReadonlyArray<string>,
) => {
  cleanedServices: Record<string, RawComposeService>;
  removedContainerNameIds: ReadonlyArray<string>;
};
