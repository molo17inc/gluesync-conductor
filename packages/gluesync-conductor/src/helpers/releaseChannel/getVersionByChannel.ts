import { ReleaseChannelTypes } from '../../models/conductor.model';
import { AgentInfoResponse } from '../agentInfo/agentInfo.model';

const getVersionByChannel = (
  agentInfo: Readonly<AgentInfoResponse>,
  channel?: ReleaseChannelTypes,
) => {
  if (!agentInfo) return null;

  switch (channel) {
    case 'alpha':
      return agentInfo.latestVersionAlpha;
    case 'beta':
      return agentInfo.latestVersionBeta;
    case 'ga':
    default:
      return agentInfo.latestVersionGA;
  }
};

export default getVersionByChannel;
