import { RawComposeService } from '../../models/composeFile.model';

export type SplitGrafanaProvisioningMountResult = {
  services: Readonly<Record<string, RawComposeService>>;
  updatedIds: ReadonlyArray<string>;
};

export type SplitGrafanaProvisioningMount = (
  services: Readonly<Record<string, RawComposeService>>,
) => SplitGrafanaProvisioningMountResult;
