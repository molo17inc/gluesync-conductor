import type { ReleaseChannelTypes } from '../../models/conductor.model';
import type { AgentInfoResponse } from '../agentInfo/agentInfo.model';

export type CheckConductorUpdateResult = Readonly<{
  needsUpdate: boolean;
  ids: ReadonlyArray<string>;
  availableVersion: string | null;
}>;

export type CheckConductorUpdateParams = Readonly<{
  composeJson: Readonly<Record<string, unknown>>;
  releaseChannel?: ReleaseChannelTypes;
  conductorServiceName?: string; // defaults to env or 'gluesync-conductor'
}>;

export type { ReleaseChannelTypes, AgentInfoResponse };
