import type { ReleaseChannelTypes } from '../../models/conductor.model';

export type CheckConductorUpdateResult = Readonly<{
  needsUpdate: boolean;
  id: string;
  availableVersion: string | null;
}>;

export type CheckConductorUpdateParams = Readonly<{
  composeJson: Readonly<Record<string, unknown>>;
  releaseChannel?: ReleaseChannelTypes;
  conductorServiceName?: string;
}>;
