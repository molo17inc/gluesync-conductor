import type Docker from 'dockerode';

import { getLogger } from '../../../utils/logger';
import stripImageDigest from '../stripImageDigest/stripImageDigest';
import { SwarmTask } from '../swarm.model';
import { GetServiceTasks } from './getServiceTasks.model';

const nodeNames = async (
  docker: Readonly<Docker>,
): Promise<ReadonlyMap<string, string>> => {
  try {
    const nodes = await docker.listNodes();

    return new Map(
      nodes.map(node => [node.ID, node.Description?.Hostname ?? '']),
    );
  } catch (error) {
    // The names are decoration, the tasks are still worth returning
    getLogger().warn({ error }, '[swarm] could not list nodes');

    return new Map();
  }
};

const getServiceTasks: GetServiceTasks = async (
  docker,
  serviceName,
  { includeStopped = false, resolveNodes = true } = {},
) => {
  const [tasks, names] = await Promise.all([
    docker.listTasks({
      filters: {
        service: [serviceName],
        ...(!includeStopped && { 'desired-state': ['running'] }),
      },
    }),
    resolveNodes ? nodeNames(docker) : new Map<string, string>(),
  ]);

  return tasks
    .map<SwarmTask>(task => ({
      taskId: task.ID,
      nodeId: task.NodeID ?? '',
      nodeName: names.get(task.NodeID) || undefined,
      state: task.Status?.State ?? '',
      desiredState: task.DesiredState ?? '',
      containerId: task.Status?.ContainerStatus?.ContainerID || undefined,
      message: task.Status?.Message || undefined,
      err: task.Status?.Err || undefined,
      createdAt: task.CreatedAt ?? '',
      updatedAt: task.UpdatedAt ?? '',
      image: stripImageDigest(task.Spec?.ContainerSpec?.Image ?? ''),
      forceUpdate: task.Spec?.ForceUpdate ?? 0,
    }))
    .sort(
      // Timestamps have a variable number of fraction digits: parse them
      (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
    );
};

export default getServiceTasks;
