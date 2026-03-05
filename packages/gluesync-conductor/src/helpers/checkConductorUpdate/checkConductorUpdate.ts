import fetchAgentInfo from '../agentInfo/agentInfo';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';
import { CheckModuleUpdate } from './checkConductorUpdate.model';

const checkModuleUpdate: CheckModuleUpdate = async (
  composeJson,
  releaseChannel,
  serviceName,
) => {
  const services = (composeJson as any).services as
    | Readonly<Record<string, { image?: string }>>
    | undefined;

  const service = services?.[serviceName];

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
    id: serviceName,
    availableVersion,
  };
};

export default checkModuleUpdate;
