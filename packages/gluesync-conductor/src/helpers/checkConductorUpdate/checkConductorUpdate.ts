import fetchAgentInfo from '../agentInfo/agentInfo';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';
import {
  AgentInfoResponse,
  CheckConductorUpdateParams,
  CheckConductorUpdateResult,
} from './checkConductorUpdate.model';

const checkConductorUpdate = async ({
  composeJson,
  releaseChannel,
  conductorServiceName = process.env.CONDUCTOR_NAME || 'gluesync-conductor',
}: CheckConductorUpdateParams): Promise<CheckConductorUpdateResult | null> => {
  // composeJson is readonly‑shallow; we only read from it
  const services = (composeJson as any).services as
    | Readonly<Record<string, { image?: string }>>
    | undefined;

  const service = services?.[conductorServiceName];

  if (!service?.image) {
    return null;
  }

  const parsed = parseImage(service.image);
  const currentTag = parsed.tag;
  const { shortImageName } = parsed;

  const info: AgentInfoResponse = await fetchAgentInfo(shortImageName);

  const availableVersion = getVersionByChannel(info, releaseChannel);

  return {
    needsUpdate: !!availableVersion && currentTag !== availableVersion,
    ids: [conductorServiceName],
    availableVersion,
  };
};

export default checkConductorUpdate;
