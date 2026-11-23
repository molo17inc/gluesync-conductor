import fetchAgentInfoFromBackoffice from '../../agentInfo/agentInfo';
import { isImageNotPublished } from '../../agentInfo/agentInfo.errors';
import { AgentInfoResponse } from '../../agentInfo/agentInfo.model';
import describeFailure from '../../describeFailure/describeFailure';
import parseImage from '../../parseImage/parseImage';
import { PipelineMaintenance } from '../../pipelineMaintenance/pipelineMaintenance.model';
import getVersionByChannel from '../../releaseChannel/getVersionByChannel';
import { LabelPrefix } from '../../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../../models/conductor.model';
import { getLogger } from '../../../utils/logger';
import {
  KubernetesClient,
  KubernetesWorkload,
  KubernetesWorkloadObject,
} from '../kubernetes.model';
import listKubernetesWorkloads from '../listKubernetesWorkloads/listKubernetesWorkloads';
import waitForKubernetesRollout, {
  RolloutOptions,
  rolloutOptionsFromEnv,
} from '../waitForKubernetesRollout/waitForKubernetesRollout';

export type KubernetesChangeItem = Readonly<{
  id: string;
  status: 'OK' | 'ERROR';
  message: string;
  pausedPipelines?: ReadonlyArray<string>;
  resumedPipelines?: ReadonlyArray<string>;
}>;

// eslint-disable-next-line functional/no-mixed-types -- injected dependencies: values and functions together
export type KubernetesChangeDeps = Readonly<{
  client: KubernetesClient;
  rollout?: RolloutOptions;
  fetchAgentInfo?: (imageName: string) => Promise<AgentInfoResponse>;
  // Core Hub's pipelines are held in maintenance mode while its image changes
  pipelineMaintenance?: PipelineMaintenance;
  coreHubName?: string;
  // Name of the pod this Conductor runs in (its HOSTNAME)
  selfPodName?: string;
  now?: () => Date;
}>;

const TYPE_LABEL = `${LabelPrefix.CONDUCTOR}.type`;

// `kubectl rollout restart` writes the same annotation
const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt';

/**
 * The Gluesync operator of the namespace, when one runs there. It sets the
 * images from its GluesyncPlatform and would put back what the Conductor
 * changed, so the two never update the same namespace.
 */
export const findOperator = (
  workloads: ReadonlyArray<KubernetesWorkload>,
): KubernetesWorkload | undefined =>
  workloads.find(workload => workload.labels[TYPE_LABEL] === 'operator');

export const OPERATOR_OWNS_UPDATES =
  'The Gluesync operator runs in this namespace and applies the updates: start them from the operator (the Core Hub UI, or spec.version of the GluesyncPlatform)';

const pathOf = (workload: Readonly<KubernetesWorkload>): string =>
  `/apis/apps/v1/namespaces/${encodeURIComponent(workload.namespace)}/${
    workload.kind === 'StatefulSet' ? 'statefulsets' : 'deployments'
  }/${encodeURIComponent(workload.name)}`;

const isSelf = (
  workload: Readonly<KubernetesWorkload>,
  selfPodName: string | undefined,
): boolean =>
  Boolean(selfPodName) &&
  workload.pods.some(pod => pod.metadata.name === selfPodName);

const setImage = (
  client: KubernetesClient,
  workload: Readonly<KubernetesWorkload>,
  image: string,
): Promise<KubernetesWorkloadObject> =>
  client.patch(pathOf(workload), {
    spec: {
      template: {
        spec: { containers: [{ name: workload.container?.name, image }] },
      },
    },
  });

// A StatefulSet does not replace a pod that never became ready when its
// template goes back: the pod is deleted so the controller makes it again
const deleteUnreadyPods = async (
  client: KubernetesClient,
  workload: Readonly<KubernetesWorkload>,
): Promise<void> => {
  const current = (await listKubernetesWorkloads(client)).find(
    ({ name }) => name === workload.name,
  );
  const unready = (current?.pods ?? []).filter(
    pod =>
      !pod.metadata.deletionTimestamp &&
      !pod.status?.containerStatuses?.every(status => status.ready),
  );

  await Promise.all(
    unready.map(pod =>
      client.delete(
        `/api/v1/namespaces/${encodeURIComponent(workload.namespace)}/pods/${encodeURIComponent(pod.metadata.name)}`,
      ),
    ),
  );
};

const rollBack = async (
  client: KubernetesClient,
  workload: Readonly<KubernetesWorkload>,
  previousImage: string,
  rollout: RolloutOptions,
): Promise<string> => {
  try {
    await setImage(client, workload, previousImage);

    if (workload.kind === 'StatefulSet') {
      await deleteUnreadyPods(client, workload);
    }

    const back = await waitForKubernetesRollout(
      client,
      workload.name,
      { ...rollout, stabilityMs: 0 },
      previousImage,
    );

    return back.ok
      ? ` Rolled back to ${previousImage}.`
      : ` Rollback to ${previousImage} did not complete: ${back.reason}.`;
  } catch (error) {
    return ` Rollback to ${previousImage} failed: ${describeFailure(error)}`;
  }
};

type Plan =
  | Readonly<{ id: string; done: KubernetesChangeItem }>
  | Readonly<{
      id: string;
      workload: KubernetesWorkload;
      previousImage: string;
      image: string;
      version: string;
    }>;

const item = (
  id: string,
  status: KubernetesChangeItem['status'],
  message: string,
): KubernetesChangeItem => ({ id, status, message });

const planOf = async (
  id: string,
  workloads: ReadonlyArray<KubernetesWorkload>,
  releaseChannel: ReleaseChannelTypes,
  fetchAgentInfo: (imageName: string) => Promise<AgentInfoResponse>,
): Promise<Plan> => {
  const workload = workloads.find(candidate => candidate.id === id);
  const previousImage = workload?.container?.image;

  if (!workload || !previousImage) {
    return {
      id,
      done: item(id, 'ERROR', `Service ${id} not found in the namespace`),
    };
  }

  const { fullName, shortImageName, tag, digest } = parseImage(previousImage);

  try {
    const version = getVersionByChannel(
      await fetchAgentInfo(shortImageName),
      releaseChannel,
    );

    if (!version) {
      return {
        id,
        done: item(
          id,
          'ERROR',
          `No ${releaseChannel} version of ${shortImageName} is published. Not updated.`,
        ),
      };
    }

    // A pinned digest is dropped: the tag alone names the new version
    return version === tag && !digest
      ? { id, done: item(id, 'OK', `Already on ${version}`) }
      : {
          id,
          workload,
          previousImage,
          image: `${fullName}:${version}`,
          version,
        };
  } catch (error) {
    return {
      id,
      done: item(
        id,
        'ERROR',
        isImageNotPublished(error)
          ? `${error.message}. Not updated.`
          : `The version on offer could not be read: ${describeFailure(error)}. Not updated.`,
      ),
    };
  }
};

/**
 * `update` on Kubernetes: each service gets the image of the version on offer
 * for the release channel, through the Kubernetes API. Kubernetes replaces the
 * pods; the Conductor waits for the rollout and the stability window, and puts
 * the previous image back when the new one does not get there. Core Hub goes
 * first, with its pipelines in maintenance mode; the Conductor's own workload
 * goes last and is not waited for (this process is replaced by it).
 */
export const updateKubernetesWorkloads = async (
  ids: ReadonlyArray<string>,
  releaseChannel: ReleaseChannelTypes,
  {
    client,
    rollout = rolloutOptionsFromEnv(),
    fetchAgentInfo = fetchAgentInfoFromBackoffice,
    pipelineMaintenance,
    coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub',
    selfPodName = process.env.HOSTNAME,
  }: KubernetesChangeDeps,
): Promise<ReadonlyArray<KubernetesChangeItem>> => {
  const logger = getLogger();
  const workloads = await listKubernetesWorkloads(client);
  const plans = await Promise.all(
    ids.map(id => planOf(id, workloads, releaseChannel, fetchAgentInfo)),
  );

  const run = async (plan: Plan): Promise<KubernetesChangeItem> => {
    if ('done' in plan) {
      return plan.done;
    }

    const { id, workload, previousImage, image, version } = plan;

    logger.info(
      { id, workload: workload.name, from: previousImage, to: image },
      '[kubernetes-update] setting the image',
    );

    try {
      await setImage(client, workload, image);

      if (isSelf(workload, selfPodName)) {
        return item(
          id,
          'OK',
          `Update to ${version} started: Kubernetes replaces this Conductor once the new one is ready`,
        );
      }

      const result = await waitForKubernetesRollout(
        client,
        workload.name,
        rollout,
        image,
      );

      if (result.ok) {
        return item(id, 'OK', `Updated to ${version}`);
      }

      logger.warn(
        { id, workload: workload.name, reason: result.reason },
        '[kubernetes-update] rollout failed, rolling back',
      );

      return item(
        id,
        'ERROR',
        `Update to ${version} failed: ${result.reason}.${await rollBack(client, workload, previousImage, rollout)}`,
      );
    } catch (error) {
      return item(
        id,
        'ERROR',
        `Update to ${version} failed: ${describeFailure(error)}`,
      );
    }
  };

  const isPlanOf = (plan: Plan, test: (w: KubernetesWorkload) => boolean) =>
    'workload' in plan && test(plan.workload);
  const coreHub = plans.find(
    plan => plan.id === coreHubName && 'workload' in plan,
  );
  const self = plans.find(plan =>
    isPlanOf(plan, workload => isSelf(workload, selfPodName)),
  );
  const others = plans.filter(plan => plan !== coreHub && plan !== self);

  // Core Hub first, alone: its pipelines leave maintenance mode as soon as it
  // is stable (or rolled back), without waiting for the modules
  const coreHubItem = await (async (): Promise<
    KubernetesChangeItem | undefined
  > => {
    if (!coreHub) {
      return undefined;
    }

    const paused = await pipelineMaintenance?.pause();
    const done = await run(coreHub);
    const resumed = paused ? await pipelineMaintenance?.resume() : undefined;

    return {
      ...done,
      ...(paused && {
        pausedPipelines: paused.paused,
        resumedPipelines: resumed?.resumed ?? [],
      }),
    };
  })();
  const otherItems = await Promise.all(others.map(run));
  const selfItem = self ? await run(self) : undefined;
  const items = [
    ...(coreHubItem ? [coreHubItem] : []),
    ...otherItems,
    ...(selfItem ? [selfItem] : []),
  ];

  // In the order the ids were given
  return ids.flatMap(id => items.find(done => done.id === id) ?? []);
};

/**
 * `restart` on Kubernetes: a rollout restart of each service (every workload
 * of the namespace when no id is given), the Conductor's own last.
 */
export const restartKubernetesWorkloads = async (
  ids: ReadonlyArray<string>,
  {
    client,
    rollout = rolloutOptionsFromEnv(),
    selfPodName = process.env.HOSTNAME,
    now = () => new Date(),
  }: KubernetesChangeDeps,
): Promise<ReadonlyArray<KubernetesChangeItem>> => {
  const workloads = await listKubernetesWorkloads(client);
  const wanted = ids.length > 0 ? ids : workloads.map(({ id }) => id);
  const restartedAt = now().toISOString();

  const restart = async (id: string): Promise<KubernetesChangeItem> => {
    const workload = workloads.find(candidate => candidate.id === id);

    if (!workload) {
      return item(id, 'ERROR', `Service ${id} not found in the namespace`);
    }

    try {
      await client.patch(pathOf(workload), {
        spec: {
          template: {
            metadata: { annotations: { [RESTARTED_AT]: restartedAt } },
          },
        },
      });

      if (isSelf(workload, selfPodName)) {
        return item(
          id,
          'OK',
          'Restart started: Kubernetes replaces this Conductor once the new one is ready',
        );
      }

      const result = await waitForKubernetesRollout(client, workload.name, {
        ...rollout,
        stabilityMs: 0,
      });

      return result.ok
        ? item(id, 'OK', 'Restarted')
        : item(id, 'ERROR', `Restart did not complete: ${result.reason}`);
    } catch (error) {
      return item(id, 'ERROR', `Restart failed: ${describeFailure(error)}`);
    }
  };

  const selfId = workloads.find(workload => isSelf(workload, selfPodName))?.id;
  const first = await Promise.all(
    wanted.filter(id => id !== selfId).map(restart),
  );
  const last =
    selfId !== undefined && wanted.includes(selfId)
      ? [await restart(selfId)]
      : [];
  const items = [...first, ...last];

  return wanted.flatMap(id => items.find(done => done.id === id) ?? []);
};
