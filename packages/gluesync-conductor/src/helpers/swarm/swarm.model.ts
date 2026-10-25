import type Docker from 'dockerode';

export const STACK_NAMESPACE_LABEL = 'com.docker.stack.namespace';

export type SwarmService = Readonly<{
  // Conductor service id: the name without the `<namespace>_` prefix
  id: string;
  serviceId: string;
  // Full swarm name (`<namespace>_<id>`)
  name: string;
  // Spec image without any `@sha256:` digest
  image: string;
  labels: Readonly<Record<string, string>>;
  // Labels of the containers (`TaskTemplate.ContainerSpec.Labels`)
  containerLabels: Readonly<Record<string, string>>;
  // Undefined for global services
  replicas?: number;
  updateState?: Docker.UpdateState;
  updateMessage?: string;
  // `Version.Index`, which every update has to send back
  version: number;
  // The whole spec, as the API wants it back on update
  spec: Docker.ServiceSpec;
  // What a rollback would restore, absent for a service never updated
  previousSpec?: Docker.ServiceSpec;
}>;

export type SwarmTask = Readonly<{
  taskId: string;
  nodeId: string;
  nodeName?: string;
  state: string;
  desiredState: string;
  containerId?: string;
  message?: string;
  err?: string;
  createdAt: string;
  updatedAt: string;
  // Image without digest
  image: string;
  // `TaskTemplate.ForceUpdate` the task was created from
  forceUpdate: number;
}>;
