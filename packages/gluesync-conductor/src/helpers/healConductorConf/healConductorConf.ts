import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAgentInfo from '../agentInfo/agentInfo';
import { AgentInfoResponse } from '../agentInfo/agentInfo.model';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';

const BAD_VOLUME = './logs/conductor:/opt/gluesync-conductor/logs';
const GOOD_VOLUME = './logs:/opt/gluesync-conductor/logs';

const healConductorConf = async (): Promise<boolean> => {
  const conductorServiceName =
    process.env.CONDUCTOR_NAME || 'gluesync-conductor';

  const composeJson = await readComposeFile({ raw: true });

  const service = composeJson.services?.[conductorServiceName];
  if (!service) {
    return false;
  }

  // Normalize environment to an array of strings
  const rawEnvArray: string[] = Array.isArray(service.environment)
    ? (service.environment as string[])
    : service.environment && typeof service.environment === 'object'
      ? Object.entries(service.environment).map(([k, v]) => `${k}=${v}`)
      : [];

  const hasGluesyncHostInitial = rawEnvArray.some(e =>
    e.startsWith('GLUESYNC_HOST='),
  );

  const { healedEnvArray, envChanged } = (() => {
    const mapped = rawEnvArray.map(e => {
      if (e.startsWith('CORE_HUB_ADDRESS=')) {
        const value = e.substring('CORE_HUB_ADDRESS='.length);
        if (!hasGluesyncHostInitial) {
          return { value: `GLUESYNC_HOST=${value}`, changed: true };
        }
        // GLUESYNC_HOST already present: drop CORE_HUB_ADDRESS
        return { value: '', changed: true };
      }
      return { value: e, changed: false };
    });

    const filtered = mapped.filter(x => x.value !== '').map(x => x.value);

    const changed = mapped.some(x => x.changed);

    return { healedEnvArray: filtered, envChanged: changed };
  })();

  const baseService = {
    ...service,
    ...(envChanged ? { environment: healedEnvArray } : {}),
  };

  const {
    fullName,
    shortImageName,
    tag: currentTag = 'latest',
  } = parseImage(baseService.image);

  // Only retag when current tag is "latest"
  if (currentTag !== 'latest') {
    const healedVolumesNonLatest = Array.isArray(baseService.volumes)
      ? baseService.volumes.map(vol =>
          typeof vol === 'string' && vol.trim() === BAD_VOLUME
            ? GOOD_VOLUME
            : vol,
        )
      : baseService.volumes;

    const volumesChangedNonLatest = Array.isArray(baseService.volumes)
      ? healedVolumesNonLatest?.some((v, i) => v !== baseService.volumes?.[i])
      : false;

    if (!volumesChangedNonLatest && !envChanged) {
      return false;
    }

    const updatedServicesNonLatest = {
      ...composeJson.services,
      [conductorServiceName]: {
        ...baseService,
        volumes: healedVolumesNonLatest,
      },
    };

    const updatedComposeNonLatest = {
      ...composeJson,
      services: updatedServicesNonLatest,
    };

    await writeComposeFile(updatedComposeNonLatest);

    return true;
  }

  // Tag is "latest": fix volumes AND maybe update tag
  const healedVolumes = Array.isArray(baseService.volumes)
    ? baseService.volumes.map(vol =>
        typeof vol === 'string' && vol.trim() === BAD_VOLUME
          ? GOOD_VOLUME
          : vol,
      )
    : baseService.volumes;

  const volumesChanged = Array.isArray(baseService.volumes)
    ? healedVolumes?.some((v, i) => v !== baseService.volumes?.[i])
    : false;

  if (!volumesChanged && !envChanged) {
    return false;
  }

  const agentInfo: AgentInfoResponse = await fetchAgentInfo(shortImageName);
  const newTag = getVersionByChannel(agentInfo, 'ga');

  if (!newTag) {
    const updatedServicesNoTag = {
      ...composeJson.services,
      [conductorServiceName]: {
        ...baseService,
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
      ...baseService,
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
