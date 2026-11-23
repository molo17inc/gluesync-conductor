import { DoContainersActionResponse } from '../doContainersAction.model';
import { ActionOutcome } from '../../../../helpers/actionGate/actionGate.model';
import {
  KubernetesChangeDeps,
  OPERATOR_OWNS_UPDATES,
  findOperator,
  restartKubernetesWorkloads,
  updateKubernetesWorkloads,
} from '../../../../helpers/kubernetes/changeKubernetesWorkloads/changeKubernetesWorkloads';
import { getKubernetesClient } from '../../../../helpers/kubernetes/kubernetesClient/kubernetesClient';
import KUBERNETES_CONTAINER_ACTIONS from '../../../../helpers/kubernetes/kubernetesContainerActions';
import listKubernetesWorkloads from '../../../../helpers/kubernetes/listKubernetesWorkloads/listKubernetesWorkloads';
import buildUnsupportedOnKubernetesReply from '../../../../helpers/orchestrator/buildUnsupportedOnKubernetesReply/buildUnsupportedOnKubernetesReply';
import createPipelineMaintenance, {
  isPipelineMaintenanceEnabled,
} from '../../../../helpers/pipelineMaintenance/pipelineMaintenance';
import {
  PausedPipelinesRecord,
  PausedPipelinesStore,
} from '../../../../helpers/pipelineMaintenance/pipelineMaintenance.model';
import {
  ContainerActions,
  ReleaseChannelTypes,
} from '../../../../models/conductor.model';

type Outcome = ActionOutcome<DoContainersActionResponse>;

// A pod has no kit folder: the pipelines an update holds are remembered by
// this process only. A Conductor replaced in the middle of a Core Hub update
// leaves them in maintenance mode (docs/kubernetes-mode.md).
const held = new Map<'record', PausedPipelinesRecord>();

const memoryStore: PausedPipelinesStore = {
  read: async () => held.get('record') ?? null,
  write: async record => {
    held.set('record', record);
  },
  clear: async () => {
    held.delete('record');
  },
};

type Request = Readonly<{
  action: ContainerActions;
  ids: ReadonlyArray<string>;
  releaseChannel: ReleaseChannelTypes;
}>;

/**
 * A container action in Kubernetes mode: `update` and `restart` change the
 * workloads of the namespace through the Kubernetes API. Errors of the API and
 * a refusal by the pipelines are thrown to the caller, as in compose mode.
 */
const performKubernetesAction = async (
  { action, ids, releaseChannel }: Request,
  overrides: Partial<KubernetesChangeDeps> = {},
): Promise<Outcome> => {
  if (!KUBERNETES_CONTAINER_ACTIONS.has(action)) {
    return {
      statusCode: 501,
      body: buildUnsupportedOnKubernetesReply(`POST /containers (${action})`),
    };
  }

  const client = overrides.client ?? getKubernetesClient();

  if (action === 'restart') {
    return {
      statusCode: 200,
      body: {
        success: true,
        data: {
          containers: await restartKubernetesWorkloads(ids, {
            ...overrides,
            client,
          }),
        },
      },
    };
  }

  if (findOperator(await listKubernetesWorkloads(client))) {
    return {
      statusCode: 409,
      body: {
        success: false,
        error: 'Updates are applied by the Gluesync operator',
        details: OPERATOR_OWNS_UPDATES,
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      success: true,
      data: {
        containers: await updateKubernetesWorkloads(ids, releaseChannel, {
          ...(isPipelineMaintenanceEnabled() && {
            pipelineMaintenance: createPipelineMaintenance({
              store: memoryStore,
            }),
          }),
          ...overrides,
          client,
        }),
      },
    },
  };
};

export default performKubernetesAction;
