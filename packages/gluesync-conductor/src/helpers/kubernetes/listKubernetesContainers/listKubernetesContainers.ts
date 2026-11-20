import { ListContainerItem } from '../../../functions/container/listContainers/listContainers.model';
import {
  ComposeFile,
  ComposeService,
  LabelPrefix,
  RawComposeFile,
  RawComposeService,
} from '../../../models/composeFile.model';
import { KubernetesClient, KubernetesWorkload } from '../kubernetes.model';
import { getKubernetesClient } from '../kubernetesClient/kubernetesClient';
import { kubernetesServiceType } from '../kubernetesServiceId/kubernetesServiceId';
import listKubernetesWorkloads from '../listKubernetesWorkloads/listKubernetesWorkloads';
import mapPodToContainerInfo from '../mapPodToContainerInfo/mapPodToContainerInfo';

const TYPE_LABEL = `${LabelPrefix.CONDUCTOR}.type`;

const typeOf = (workload: Readonly<KubernetesWorkload>) =>
  kubernetesServiceType(workload.id, workload.image, workload.labels);

// Only the values written in the manifest: one that comes from a Secret, a
// ConfigMap or a field is not readable here, and is left out
const literalEnvironment = (
  workload: Readonly<KubernetesWorkload>,
): Record<string, string> =>
  Object.fromEntries(
    (workload.container?.env ?? [])
      .filter(({ value }) => typeof value === 'string')
      .map(({ name, value }) => [name, value as string]),
  );

/**
 * A workload as the compose service the rest of the Conductor reads: its
 * image, labels (with the Conductor type, as a Docker kit has after adoption),
 * literal environment and replicas. There is no compose file on Kubernetes:
 * the workload is the persisted definition.
 */
export const toComposeService = (
  workload: Readonly<KubernetesWorkload>,
): ComposeService => {
  const type = typeOf(workload);

  return {
    image: workload.image,
    labels: {
      ...workload.labels,
      ...(type === 'unknown' ? {} : { [TYPE_LABEL]: type }),
    },
    environment: literalEnvironment(workload),
    deploy: { replicas: workload.desiredReplicas },
  };
};

const toKeyValueList = (
  record: Readonly<Record<string, unknown>> = {},
): ReadonlyArray<string> =>
  Object.entries(record).map(([key, value]) => `${key}=${String(value)}`);

// `raw`: labels and environment as `key=value` lists, the way a compose file
// written by hand has them
const toRawComposeService = ({
  image,
  deploy,
  labels,
  environment,
}: Readonly<ComposeService>): RawComposeService => ({
  image,
  deploy,
  labels: toKeyValueList(labels),
  environment: toKeyValueList(environment),
});

/** The workloads as the `services` of a compose file, keyed by Conductor id. */
export const toComposeFile = (
  workloads: ReadonlyArray<KubernetesWorkload>,
): ComposeFile => ({
  services: Object.fromEntries(
    workloads.map(workload => [workload.id, toComposeService(workload)]),
  ),
});

export function readKubernetesServices(
  options: Readonly<{ raw: true; client?: KubernetesClient }>,
): Promise<RawComposeFile>;
export function readKubernetesServices(
  options?: Readonly<{ raw?: false; client?: KubernetesClient }>,
): Promise<ComposeFile>;
export function readKubernetesServices(
  options?: Readonly<{ raw?: boolean; client?: KubernetesClient }>,
): Promise<RawComposeFile | ComposeFile>;

/**
 * What `readComposeFile` is to a Docker kit: the service definitions, read
 * from the StatefulSets and Deployments of the namespace.
 */
export async function readKubernetesServices({
  raw = false,
  client = getKubernetesClient(),
}: Readonly<{ raw?: boolean; client?: KubernetesClient }> = {}): Promise<
  RawComposeFile | ComposeFile
> {
  const { services = {} } = toComposeFile(
    await listKubernetesWorkloads(client),
  );

  return raw
    ? {
        services: Object.fromEntries(
          Object.entries(services).map(([id, service]) => [
            id,
            toRawComposeService(service),
          ]),
        ),
      }
    : { services };
}

/**
 * Same items as GET /containers in compose mode, from the workloads of the
 * namespace and their pods: `service` is the workload, `info` the pod shown
 * (absent when the workload has none, like a stopped compose service).
 */
const listKubernetesContainers = async (
  client: KubernetesClient = getKubernetesClient(),
): Promise<ReadonlyArray<ListContainerItem>> =>
  (await listKubernetesWorkloads(client)).map(workload => {
    const service = toComposeService(workload);
    const [shown] = workload.pods;

    return {
      id: workload.id,
      persisted: true,
      agentId: service.environment?.INITIAL_AGENT_ID
        ? String(service.environment.INITIAL_AGENT_ID)
        : undefined,
      type: typeOf(workload),
      service,
      info: shown ? mapPodToContainerInfo(workload, shown) : undefined,
    };
  });

export default listKubernetesContainers;
