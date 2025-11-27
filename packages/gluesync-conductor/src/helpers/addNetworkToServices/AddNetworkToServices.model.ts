// addNetworkToServices.ts
import { RawComposeService } from '../../models/composeFile.model';

export type AddNetworkToServicesResult = {
  services: Readonly<Record<string, RawComposeService>>;
  updatedIds: ReadonlyArray<string>;
};

export type AddNetworkToServices = (
  services: Readonly<Record<string, RawComposeService>>,
  serviceIds: ReadonlyArray<string>,
  networkName: string,
) => AddNetworkToServicesResult;
