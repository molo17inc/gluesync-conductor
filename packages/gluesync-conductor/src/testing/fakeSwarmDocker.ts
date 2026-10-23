import type Docker from 'dockerode';

type Filters = Readonly<Record<string, ReadonlyArray<string>>>;

export type FakeService = Readonly<{
  ID: string;
  Version?: { Index: number };
  Spec: Record<string, any>;
  PreviousSpec?: Record<string, any>;
  UpdateStatus?: { State?: string; Message?: string };
}>;

export type FakeTask = Readonly<Record<string, any>>;

export type FakeSwarmOptions = Readonly<{
  // A function is asked again on every call, to play a service changing
  services?: ReadonlyArray<FakeService> | (() => ReadonlyArray<FakeService>);
  tasks?: ReadonlyArray<FakeTask> | (() => ReadonlyArray<FakeTask>);
  nodes?: ReadonlyArray<Record<string, any>>;
  // Rejects `service.update` with this error (once per entry)
  updateErrors?: ReadonlyArray<Error>;
  listNodesFails?: boolean;
}>;

// What the helpers asked of the fake, for the specs to look at
export type SwarmCalls = {
  listServices: Array<Record<string, any> | undefined>;
  listTasks: Array<Record<string, any> | undefined>;
  listNodes: number;
  // `query` and `body` are the `_query` and `_body` of what dockerode got
  updates: Array<{
    id: string;
    query: Record<string, any>;
    body: Record<string, any>;
  }>;
  removed: string[];
};

// A replicated service of the `gs` stack the way `GET /services` returns it
export const buildService = (
  id: string,
  extra: Readonly<{
    image?: string;
    replicas?: number;
    version?: number;
    labels?: Record<string, string>;
    containerLabels?: Record<string, string>;
    forceUpdate?: number;
    state?: string;
    message?: string;
    previousSpec?: Record<string, any>;
    updateConfig?: Record<string, any>;
    global?: boolean;
  }> = {},
): FakeService => ({
  ID: `${id}-sid`,
  Version: { Index: extra.version ?? 7 },
  Spec: {
    Name: `gs_${id}`,
    Labels: {
      'com.docker.stack.namespace': 'gs',
      ...extra.labels,
    },
    TaskTemplate: {
      ContainerSpec: {
        Image: extra.image ?? `molo17/gluesync-${id}:2.3.0`,
        Labels: extra.containerLabels ?? {},
        Env: ['A=1'],
      },
      ForceUpdate: extra.forceUpdate ?? 0,
      Placement: { Constraints: ['node.role == manager'] },
    },
    Mode: extra.global
      ? { Global: {} }
      : { Replicated: { Replicas: extra.replicas ?? 1 } },
    ...(extra.updateConfig && { UpdateConfig: extra.updateConfig }),
  },
  ...(extra.previousSpec && { PreviousSpec: extra.previousSpec }),
  ...(extra.state && {
    UpdateStatus: { State: extra.state, Message: extra.message },
  }),
});

// A task of `buildService(id)` as the Tasks API returns it
export const buildTask = (
  id: string,
  extra: Readonly<{
    taskId?: string;
    state?: string;
    desired?: string;
    nodeId?: string;
    createdAt?: string;
    image?: string;
    forceUpdate?: number;
    err?: string;
    message?: string;
    containerId?: string;
  }> = {},
): FakeTask => ({
  ID: extra.taskId ?? `${id}-task`,
  ServiceName: `gs_${id}`,
  ServiceID: `${id}-sid`,
  NodeID: extra.nodeId ?? 'node-1',
  DesiredState: extra.desired ?? 'running',
  CreatedAt: extra.createdAt ?? '2026-10-23T10:00:00.000000000Z',
  UpdatedAt: '2026-10-23T10:00:05.000000000Z',
  Spec: {
    ContainerSpec: {
      Image:
        extra.image ?? `molo17/gluesync-${id}:2.3.0@sha256:0123456789abcdef`,
    },
    ForceUpdate: extra.forceUpdate ?? 0,
  },
  Status: {
    State: extra.state ?? 'running',
    Err: extra.err,
    Message: extra.message,
    ContainerStatus: { ContainerID: extra.containerId ?? `${id}-container` },
  },
});

const notFound = (id: string): Error =>
  Object.assign(new Error(`(HTTP code 404) no such service - ${id}`), {
    statusCode: 404,
  });

const resolve = <T>(value: T | (() => T)): T =>
  typeof value === 'function' ? (value as () => T)() : value;

/**
 * Just enough of dockerode's swarm calls for the helpers under helpers/swarm:
 * label and name filters on services, service and desired-state filters on
 * tasks, and a record of every update and removal.
 */
const fakeSwarmDocker = ({
  services = [],
  tasks = [],
  nodes = [],
  updateErrors = [],
  listNodesFails = false,
}: FakeSwarmOptions = {}) => {
  const calls: SwarmCalls = {
    listServices: [],
    listTasks: [],
    listNodes: 0,
    updates: [],
    removed: [],
  };
  const pendingErrors = [...updateErrors];

  const find = (id: string): FakeService | undefined =>
    resolve(services).find(s => s.ID === id || s.Spec.Name === id);

  const docker = {
    listServices: async (options?: { filters?: Filters }) => {
      calls.listServices.push(options);
      const labels = options?.filters?.label ?? [];

      return resolve(services).filter(service =>
        labels.every(label => {
          const [key, value] = label.split('=');

          return service.Spec.Labels?.[key] === value;
        }),
      );
    },
    listTasks: async (options?: { filters?: Filters }) => {
      calls.listTasks.push(options);
      const wantedServices = options?.filters?.service;
      const desired = options?.filters?.['desired-state'];

      return resolve(tasks).filter(
        task =>
          (!wantedServices || wantedServices.includes(task.ServiceName)) &&
          (!desired || desired.includes(task.DesiredState)),
      );
    },
    listNodes: async () => {
      calls.listNodes += 1;
      if (listNodesFails) {
        throw new Error('This node is not a swarm manager');
      }

      return nodes;
    },
    getService: (id: string) => ({
      inspect: async () => {
        const service = find(id);
        if (!service) {
          throw notFound(id);
        }

        return service;
      },
      update: async (options: Record<string, any>) => {
        const error = pendingErrors.shift();
        if (error) {
          throw error;
        }
        if (!find(id)) {
          throw notFound(id);
        }
        const { _query: query, _body: body } = options;
        calls.updates.push({ id, query, body });
      },
      remove: async () => {
        if (!find(id)) {
          throw notFound(id);
        }
        calls.removed.push(id);
      },
    }),
  } as unknown as Docker;

  return { docker, calls };
};

export default fakeSwarmDocker;
