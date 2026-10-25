import agentsJson from '../../../agents.json';
import { THIRD_PARTY_SERVICES } from '../fetchAllServicesInCompose/fetchAllServicesInCompose.model';
import parseImage from '../parseImage/parseImage';
import {
  InferServiceType,
  InferTypeFromAgentsJson,
} from './inferServiceType.model';

export const inferTypeFromAgentsJson: InferTypeFromAgentsJson = imageName => {
  const agentEntry = (agentsJson.data || []).find(
    (agent: any) => agent.dockerHubRepoName === imageName,
  );

  if (!agentEntry) {
    return null;
  }

  if (agentEntry.dockerHubRepoName === 'gluesync-core-hub') {
    return 'core-hub';
  }

  const isTargetValid = typeof agentEntry.isTarget === 'boolean';
  const isSourceValid = typeof agentEntry.isSource === 'boolean';

  if (isTargetValid && isSourceValid) {
    if (agentEntry.isTarget || agentEntry.isSource) {
      return 'agent';
    }
    return 'module';
  }

  // If neither property is a boolean, we consider it unmatched
  return null;
};

const inferServiceType: InferServiceType = (id, image) =>
  THIRD_PARTY_SERVICES.has(id)
    ? 'third-party'
    : inferTypeFromAgentsJson(parseImage(image).imageName);

export default inferServiceType;
