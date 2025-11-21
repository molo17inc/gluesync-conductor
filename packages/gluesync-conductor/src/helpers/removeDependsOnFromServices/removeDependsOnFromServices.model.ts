import {
  RawComposeFile,
  RawComposeService,
} from '../../models/composeFile.model';

export type RemoveDependsOnFromServices = (
  composeJson: RawComposeFile,
  servicesIds: ReadonlyArray<string>,
) => {
  cleanedServices: Record<string, RawComposeService>;
  removedDependsOnIds: ReadonlyArray<string>;
};
