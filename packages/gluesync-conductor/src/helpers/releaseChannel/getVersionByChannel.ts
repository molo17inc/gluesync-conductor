import { AgentInfoResponse } from '../agentInfo/agentInfo.model';

const getVersionByChannel = (
  agentInfo: Readonly<AgentInfoResponse>,
  channel?: string,
) => {
  if (!agentInfo.AvailableAgents) return null;

  switch (channel) {
    case 'alpha':
      return agentInfo.AvailableAgents.latestVersionAlpha;
    case 'beta':
      return agentInfo.AvailableAgents.latestVersionBeta;
    case 'ga':
    default:
      return agentInfo.AvailableAgents.latestVersionGA;
  }
};

export default getVersionByChannel;
