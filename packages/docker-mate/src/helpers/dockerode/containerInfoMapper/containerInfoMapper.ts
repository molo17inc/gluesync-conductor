import {
  ContainerState,
  containerStateValues,
} from '../../../models/dockerode.model';
import { ContainerInfoMapper } from './containerInfoMapper.model';

import getCustomLabels from '../../composeFile/getCustomLabels/getCustomLabels';
import parseImage from '../../../helpers/parseImage/parseImage';
import { LabelPrefix } from '../../../models/composeFile.model';

const containerInfoMapper: ContainerInfoMapper = ({
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
}) => {
  const { unique_id: uniqueId, versiontag } = getCustomLabels(labels);
  const { tag } = parseImage(image);

  const currentServiceName = labels[`${LabelPrefix.COMPOSE}.service`];

  return {
    id,
    name: names.length > 0 ? names[0].replace(/^\//, '') : '',
    image,
    imageID,
    command,
    created,
    ports: ports.map(
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
    mounts: mounts.map(
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
    tag,
    versionTag: versiontag || '',
    persisted: uniqueId === currentServiceName,
  };
};

export default containerInfoMapper;
