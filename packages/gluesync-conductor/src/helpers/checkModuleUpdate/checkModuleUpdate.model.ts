import type { ReleaseChannelTypes } from '../../models/conductor.model';

export type CheckModuleUpdateResult = Readonly<{
  needsUpdate: boolean;
  id: string;
  availableVersion: string | null;
}>;

export type CheckModuleUpdateParams = Readonly<{
  composeJson: Readonly<Record<string, unknown>>;
  releaseChannel: ReleaseChannelTypes;
  serviceName: string;
}>;

export type CheckModuleUpdate = (
  composeJson: Readonly<Record<string, unknown>>,
  releaseChannel: ReleaseChannelTypes,
  serviceName: string,
) => Promise<CheckModuleUpdateResult | null>;
