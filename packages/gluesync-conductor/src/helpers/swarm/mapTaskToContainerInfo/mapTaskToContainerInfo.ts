import type Docker from 'dockerode';

import { ContainerState } from '../../../models/dockerode.model';
import getCustomLabels from '../../composeFile/getCustomLabels/getCustomLabels';
import parseImage from '../../parseImage/parseImage';
import { containerSpecOf } from '../mapService/mapService';
import { MapTaskToContainerInfo } from './mapTaskToContainerInfo.model';

// Swarm task states onto the container states the UI knows
const containerStates: Readonly<Record<string, ContainerState>> = {
  new: 'created',
  pending: 'created',
  assigned: 'created',
  accepted: 'created',
  preparing: 'created',
  ready: 'created',
  starting: 'created',
  running: 'running',
  complete: 'exited',
  shutdown: 'exited',
  failed: 'exited',
  rejected: 'exited',
  remove: 'removing',
  orphaned: 'dead',
};

const toState = (taskState: string): ContainerState | 'unknown' =>
  containerStates[taskState] ?? 'unknown';

const toUnixSeconds = (iso: string): number => {
  const millis = Date.parse(iso);

  return Number.isNaN(millis) ? 0 : Math.floor(millis / 1000);
};

const toPorts = (spec: Readonly<Docker.ServiceSpec>) =>
  (spec.EndpointSpec?.Ports ?? []).map(port => ({
    ip: '',
    privatePort: port.TargetPort ?? 0,
    publicPort: port.PublishedPort ?? 0,
    type: port.Protocol ?? 'tcp',
  }));

const toMounts = (spec: Readonly<Docker.ServiceSpec>) =>
  (containerSpecOf(spec)?.Mounts ?? []).map(mount => ({
    type: mount.Type ?? '',
    source: mount.Source ?? '',
    destination: mount.Target ?? '',
    mode: '',
    rw: !mount.ReadOnly,
    propagation: '',
  }));

/**
 * The `info` of GET /containers for a service, in the shape a compose
 * container gets from containerInfoMapper, plus the `swarm` details.
 */
const mapTaskToContainerInfo: MapTaskToContainerInfo = ({
  service,
  task,
  runningTasks,
  wantedTasks,
}) => {
  // Container labels win over service labels, as the `type` label of a stack
  // file may sit under either `labels` or `deploy.labels`
  const labels = { ...service.labels, ...service.containerLabels };
  const { service_id: uniqueId, type } = getCustomLabels(labels);
  const image = task.image || service.image;
  const parsedImage = parseImage(image);

  const detail = task.err ?? task.message;

  return {
    id: task.containerId ?? task.taskId,
    // The slot is not known here, which is the only part of Docker's own name
    name: `${service.name}.${task.taskId}`,
    image,
    imageID: '',
    command: '',
    created: toUnixSeconds(task.createdAt),
    ports: toPorts(service.spec),
    labels,
    state: toState(task.state),
    status: detail ? `${task.state}: ${detail}` : task.state,
    hostConfig: { networkMode: 'overlay' },
    networkSettings: { networks: {} },
    mounts: toMounts(service.spec),
    tag: parsedImage.tag,
    parsedImage,
    uniqueId,
    type,
    swarm: {
      serviceId: service.serviceId,
      node: task.nodeName ?? (task.nodeId || undefined),
      replicas: runningTasks,
      desiredReplicas: service.replicas ?? wantedTasks,
      updateState: service.updateState,
    },
  };
};

export default mapTaskToContainerInfo;
