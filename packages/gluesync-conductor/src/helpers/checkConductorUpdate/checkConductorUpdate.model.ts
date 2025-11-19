import type { ReleaseChannelTypes } from '../../models/conductor.model';
import type { AgentInfoResponse } from '../agentInfo/agentInfo.model';

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

export type { ReleaseChannelTypes, AgentInfoResponse };
