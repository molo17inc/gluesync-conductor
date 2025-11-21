import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAgentInfo from '../agentInfo/agentInfo';
import { AgentInfoResponse } from '../agentInfo/agentInfo.model';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';

const BAD_VOLUME = './logs/conductor:/opt/gluesync-conductor/logs';
const GOOD_VOLUME = './logs:/opt/gluesync-conductor/logs';

const healConductorConf = async (releaseChannel: string): Promise<boolean> => {
  const conductorServiceName =
    process.env.CONDUCTOR_NAME || 'gluesync-conductor';

  const composeJson = await readComposeFile({ raw: true });

  const service = composeJson.services?.[conductorServiceName];
  if (!service || !Array.isArray(service.volumes)) {
    return false;
  }

  const {
    fullName,
    shortImageName,
    tag: currentTag = 'latest',
  } = parseImage(service.image);

  // Only retag when current tag is "latest"
  if (currentTag !== 'latest') {
    const healedVolumesNonLatest = service.volumes.map(vol =>
      typeof vol === 'string' && vol.trim() === BAD_VOLUME ? GOOD_VOLUME : vol,
    );

    const volumesChangedNonLatest = healedVolumesNonLatest.some(
      (v, i) => v !== service.volumes?.[i],
    );

    if (!volumesChangedNonLatest) {
      return false;
    }

    const updatedServicesNonLatest = {
      ...composeJson.services,
      [conductorServiceName]: {
        ...service,
        volumes: healedVolumesNonLatest,
      },
    };

    const updatedComposeNonLatest = {
      ...composeJson,
      services: updatedServicesNonLatest,
    };

    await writeComposeFile(updatedComposeNonLatest);

    // Volumes fixed, tag unchanged
    return true;
  }
  // Tag is "latest": fix volumes AND update tag

  const healedVolumes = service.volumes.map(vol =>
    typeof vol === 'string' && vol.trim() === BAD_VOLUME ? GOOD_VOLUME : vol,
  );

  const volumesChanged = healedVolumes.some(
    (v, i) => v !== service.volumes?.[i],
  );

  if (!volumesChanged) {
    // Nothing to heal → don't touch tag
    return false;
  }

  // Fetch agent info and compute new tag like in canUpdateContainers
  const agentInfo: AgentInfoResponse = await fetchAgentInfo(shortImageName);

  // Same version resolving logic as canUpdateContainers
  const newTag = getVersionByChannel(agentInfo, 'ga');
  if (!newTag) {
    // cannot determine new tag → still persist fixed volumes, no retag
    const updatedServicesNoTag = {
      ...composeJson.services,
      [conductorServiceName]: {
        ...service,
        volumes: healedVolumes,
      },
    };

    const updatedComposeNoTag = {
      ...composeJson,
      services: updatedServicesNoTag,
    };

    await writeComposeFile(updatedComposeNoTag);

    return true;
  }

  const newImage = `${fullName}:${newTag}`;

  const updatedServices = {
    ...composeJson.services,
    [conductorServiceName]: {
      ...service,
      volumes: healedVolumes,
      image: newImage,
    },
  };

  const updatedCompose = {
    ...composeJson,
    services: updatedServices,
  };

  await writeComposeFile(updatedCompose);

  return true;
};

export default healConductorConf;
