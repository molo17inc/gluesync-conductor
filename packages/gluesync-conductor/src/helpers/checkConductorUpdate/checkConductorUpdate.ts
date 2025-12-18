import fetchAgentInfo from '../agentInfo/agentInfo';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';
import {
  CheckConductorUpdateParams,
  CheckConductorUpdateResult,
} from './checkConductorUpdate.model';

const checkConductorUpdate = async ({
  composeJson,
  releaseChannel,
  conductorServiceName = process.env.CONDUCTOR_NAME || 'gluesync-conductor',
}: CheckConductorUpdateParams): Promise<CheckConductorUpdateResult | null> => {
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

  // Separate version and suffix
  const dashIndex = currentTag.indexOf('-');
  const currentVersion =
    dashIndex !== -1 ? currentTag.slice(0, dashIndex) : currentTag;

  const info = await fetchAgentInfo(shortImageName);
  const availableVersion = getVersionByChannel(info, releaseChannel);

  // Only compare version, ignore suffix
  const needsUpdate = !!availableVersion && currentVersion !== availableVersion;

  return {
    needsUpdate,
    id: conductorServiceName,
    availableVersion,
  };
};

export default checkConductorUpdate;
