import type Docker from 'dockerode';

import { LabelPrefix } from '../../../models/composeFile.model';
import { getLogger } from '../../../utils/logger';
import parseServiceType from '../../composeFile/parseServiceType/parseServiceType';
import inferServiceType from '../../inferServiceType/inferServiceType';
import getServiceTasks from '../getServiceTasks/getServiceTasks';
import listStackServices from '../listStackServices/listStackServices';
import mapTaskToContainerInfo from '../mapTaskToContainerInfo/mapTaskToContainerInfo';
import { declaredStackServiceType } from '../stackServiceType/stackServiceType';
import { SwarmService } from '../swarm.model';
import { ListSwarmContainers } from './listSwarmContainers.model';

const TYPE_LABEL = `${LabelPrefix.CONDUCTOR}.type`;

const nodeNames = async (
  docker: Readonly<Docker>,
): Promise<ReadonlyMap<string, string>> => {
  try {
    const nodes = await docker.listNodes();

    return new Map(
      nodes.map(node => [node.ID, node.Description?.Hostname ?? '']),
    );
  } catch (error) {
    // Only decoration: the node id is shown instead
    getLogger().warn({ error }, '[swarm] could not list nodes');

    return new Map();
  }
};

const swarmType = (swarmService?: SwarmService) =>
  parseServiceType(swarmService?.labels[TYPE_LABEL]) ||
  parseServiceType(swarmService?.containerLabels[TYPE_LABEL]);

/**
 * Same items as GET /containers in compose mode, from the stack file and the
 * services of the stack instead of the containers of this node.
 */
const listSwarmContainers: ListSwarmContainers = async (
  docker,
  namespace,
  composeJson,
) => {
  const [swarmServices, nodes] = await Promise.all([
    listStackServices(docker, namespace),
    nodeNames(docker),
  ]);

  const byId = new Map(swarmServices.map(service => [service.id, service]));

  const ids = [
    ...new Set([
      ...Object.keys(composeJson.services ?? {}),
      ...swarmServices.map(({ id }) => id),
    ]),
  ];

  return Promise.all(
    ids.map(async id => {
      const service = composeJson.services?.[id];
      const swarmService = byId.get(id);

      // Newest first, and the stopped ones too: a service whose tasks all
      // failed still shows the last one
      const tasks = swarmService
        ? await getServiceTasks(docker, swarmService.name, {
            includeStopped: true,
            resolveNodes: false,
          })
        : [];
      const running = tasks.filter(({ state }) => state === 'running');
      const shown = running[0] ?? tasks[0];

      const info =
        swarmService && shown
          ? mapTaskToContainerInfo({
              service: swarmService,
              task: {
                ...shown,
                nodeName: nodes.get(shown.nodeId) || undefined,
              },
              runningTasks: running.filter(
                ({ desiredState }) => desiredState === 'running',
              ).length,
              wantedTasks: tasks.filter(
                ({ desiredState }) => desiredState === 'running',
              ).length,
            })
          : undefined;

      const type =
        // The stack file is never edited to add the label, so a service
        // without one is typed the way autoAdoptServices would have
        declaredStackServiceType(service) ||
        swarmType(swarmService) ||
        parseServiceType(info?.type) ||
        inferServiceType(id, service?.image ?? swarmService?.image) ||
        'unknown';

      return {
        id,
        persisted: Boolean(service),
        agentId: service?.environment?.INITIAL_AGENT_ID
          ? String(service.environment.INITIAL_AGENT_ID)
          : undefined,
        type,
        service,
        info,
      };
    }),
  );
};

export default listSwarmContainers;
