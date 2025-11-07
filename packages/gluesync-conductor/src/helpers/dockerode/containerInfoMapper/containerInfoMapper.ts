import {
  ContainerState,
  containerStateValues,
} from '../../../models/dockerode.model';
import { ContainerInfoMapper } from './containerInfoMapper.model';

import getCustomLabels from '../../composeFile/getCustomLabels/getCustomLabels';
import parseImage from '../../parseImage/parseImage';

const containerInfoMapper: ContainerInfoMapper = container => {
  if (!container) {
    return undefined;
  }

  const {
    Id: id,
    Names: names,
    Image: image,
    ImageID: imageID,
    Command: command,
    Created: created,
    Ports: ports,
    Labels: labels,
    State: state,
    Status: status,
    HostConfig: hostConfig,
    NetworkSettings: networkSettings,
    Mounts: mounts,
  } = container;

  const { service_id: uniqueId, type } = getCustomLabels(labels);
  const parsedImage = parseImage(image);

  return {
    id,
    name: names.length > 0 ? names[0].replace(/^\//, '') : '',
    image,
    imageID,
    command,
    created,
    ports: (ports || []).map(
      ({
        IP: ip,
        PrivatePort: privatePort,
        PublicPort: publicPort,
        Type: type,
      }) => ({
        ip,
        privatePort,
        publicPort,
        type,
      }),
    ),
    labels,
    state: containerStateValues.includes(state as ContainerState)
      ? (state as ContainerState)
      : 'unknown',
    status,
    hostConfig: {
      networkMode: hostConfig.NetworkMode,
    },
    networkSettings: {
      networks: Object.entries(networkSettings.Networks).reduce(
        (acc, [key, value]) => ({
          ...acc,
          [key]: {
            iPAMConfig: value.IPAMConfig,
            links: value.Links,
            aliases: value.Aliases,
            networkID: value.NetworkID,
            endpointID: value.EndpointID,
            gateway: value.Gateway,
            iPAddress: value.IPAddress,
            iPPrefixLen: value.IPPrefixLen,
            iPv6Gateway: value.IPv6Gateway,
            globalIPv6Address: value.GlobalIPv6Address,
            globalIPv6PrefixLen: value.GlobalIPv6PrefixLen,
            macAddress: value.MacAddress,
          },
        }),
        {},
      ),
    },
    mounts: (mounts || []).map(
      ({
        Name: name,
        Type: type,
        Source: source,
        Destination: destination,
        Driver: driver,
        Mode: mode,
        RW: rw,
        Propagation: propagation,
      }) => ({
        name,
        type,
        source,
        destination,
        driver,
        mode,
        rw,
        propagation,
      }),
    ),
    tag: parsedImage.tag,
    parsedImage: { ...parsedImage },
    uniqueId,
    type,
  };
};

export default containerInfoMapper;

// // Get detailed information for each container
// const getContainerDetails = async (
//   containerInfo: any,
// ): Promise<ContainerListItem> => {
//   try {
//     const container = req.server.docker.getContainer(containerInfo.Id);
//     const details = await container.inspect();

//     // Extract the specific fields we need
//     const imageString = details.Config?.Image || '';
//     const { tag } = parseImage(imageString);

//     // Check if this container is persisted in the compose file
//     const labels = details.Config?.Labels || {};
//     const uniqueId = labels['com.molo17.conductor.unique_id'];

//     const persisted = uniqueId
//       ? Object.values(composeJson.services || {}).some(
//           service =>
//             Array.isArray(service.labels) &&
//             service.labels.includes(
//               `com.molo17.conductor.unique_id=${uniqueId}`,
//             ),
//         )
//       : false;

//     const containerDetails: ContainerListItem = {
//       id: details.Id,
//       name: details.Name ? details.Name.replace(/^\//, '') : '',
//       image: imageString,
//       tag: tag,
//       persisted,
//       created: details.Created ? details.Created.toString() : '',
//       // Extract State fields directly
//       running: details.State?.Running || false,
//       status: details.State?.Status || '',
//       exitCode: details.State?.ExitCode || 0,
//       startedAt: details.State?.StartedAt || '',
//       finishedAt: details.State?.FinishedAt || '',
//       // Extract Config fields directly
//       cmd: details.Config?.Cmd || [],
//       env: details.Config?.Env || [],
//       labels: details.Config?.Labels || {},
//       // Extract HostConfig fields directly
//       networkMode: details.HostConfig?.NetworkMode || '',
//       privileged: details.HostConfig?.Privileged || false,
//       // Include other important fields
//       ports: containerInfo.Ports || [],
//       mounts: details.Mounts || [],
//       // Include full HostConfig
//       hostConfig: details.HostConfig || {},
//     };

//     return containerDetails;
//   } catch (inspectError) {
//     req.log.error(
//       `Error inspecting container ${containerInfo.Id}: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`,
//     );
//     // Return basic info if inspect fails
//     const fallbackImageString = containerInfo.Image || '';
//     const { tag } = parseImage(fallbackImageString);

//     // For containers where inspect fails, assume they're not persisted
//     return {
//       id: containerInfo.Id,
//       name: containerInfo.Names?.[0]?.replace(/^\//, '') || '',
//       image: fallbackImageString,
//       tag: tag,
//       persisted: false, // Can't check labels if inspect fails
//       created: containerInfo.Created
//         ? containerInfo.Created.toString()
//         : '',
//       running: containerInfo.State === 'running',
//       status: containerInfo.State || '',
//       exitCode: 0,
//       startedAt: '',
//       finishedAt: '',
//       cmd: [],
//       env: [],
//       labels: containerInfo.Labels || {},
//       networkMode: 'default',
//       privileged: false,
//       ports: containerInfo.Ports || [],
//       mounts: [],
//       hostConfig: {}, // Empty object for containers where inspect fails
//     };
//   }
// };
