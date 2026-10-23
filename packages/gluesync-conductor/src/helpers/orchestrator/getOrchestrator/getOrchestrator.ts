import os from 'node:os';
import type Docker from 'dockerode';

import { getLogger } from '../../../utils/logger';
import {
  GetDecidedOrchestrator,
  GetOrchestrator,
  Orchestrator,
  SwarmOrchestrator,
} from './getOrchestrator.model';

const SERVICE_LABEL = 'com.docker.swarm.service.name';
const NAMESPACE_LABEL = 'com.docker.stack.namespace';

const COMPOSE: Orchestrator = { mode: 'compose' };

// The mode cannot change while the process runs, so it is decided once
const cache = new Map<string, Orchestrator>();

export const resetOrchestratorCache = (): void => {
  cache.clear();
};

type SelfLabels = Readonly<Record<string, string>>;

const isNotFound = (error: unknown): boolean =>
  (error as { statusCode?: number })?.statusCode === 404;

// `undefined` when this process is not a container Docker knows (dev run on a
// host): that is an answer, not a failure.
const inspectSelfLabels = async (
  docker: Readonly<Docker>,
): Promise<SelfLabels | undefined> => {
  try {
    const inspect = await docker.getContainer(os.hostname()).inspect();

    return inspect.Config?.Labels ?? {};
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }

    throw error;
  }
};

const withoutNamespace = (serviceName: string, namespace: string): string =>
  serviceName.startsWith(`${namespace}_`)
    ? serviceName.slice(namespace.length + 1)
    : serviceName;

const toSwarm = async (
  docker: Readonly<Docker>,
  namespace: string,
  selfService: string,
): Promise<SwarmOrchestrator> => {
  const info = await docker.info();

  return {
    mode: 'swarm',
    namespace,
    selfService,
    isManager: info?.Swarm?.ControlAvailable === true,
  };
};

const detect = async (docker: Readonly<Docker>): Promise<Orchestrator> => {
  const forced = process.env.CONDUCTOR_ORCHESTRATOR?.trim().toLowerCase();

  if (forced === 'compose') {
    return COMPOSE;
  }

  const labels = await inspectSelfLabels(docker);

  if (forced === 'swarm') {
    const namespace =
      process.env.SWARM_STACK_NAMESPACE?.trim() || labels?.[NAMESPACE_LABEL];

    if (!namespace) {
      throw new Error(
        'CONDUCTOR_ORCHESTRATOR=swarm needs SWARM_STACK_NAMESPACE or a stack label on the Conductor container',
      );
    }

    return toSwarm(
      docker,
      namespace,
      process.env.CONDUCTOR_NAME || 'gluesync-conductor',
    );
  }

  const serviceName = labels?.[SERVICE_LABEL];
  const namespace = labels?.[NAMESPACE_LABEL];

  // Started with `docker stack deploy` or a plain `docker service create`: only
  // the first has a stack, and only a stack's services are managed here
  return serviceName && namespace
    ? toSwarm(docker, namespace, withoutNamespace(serviceName, namespace))
    : COMPOSE;
};

/**
 * The mode when it could be determined, `undefined` when Docker could not be
 * asked. Unlike `getOrchestrator` it never guesses compose: callers that edit
 * the compose file or recreate containers must not do it inside a swarm just
 * because the daemon was briefly unreachable. Not cached on failure.
 */
export const getDecidedOrchestrator: GetDecidedOrchestrator = async docker => {
  const cached = cache.get('value');

  if (cached) {
    return cached;
  }

  try {
    const orchestrator = await detect(docker);

    cache.set('value', orchestrator);

    return orchestrator;
  } catch (error) {
    getLogger().warn(
      { error },
      '[orchestrator] could not detect the orchestrator',
    );

    return undefined;
  }
};

/**
 * Compose or Swarm, decided once per process (see docs/swarm-mode.md).
 * Any failure to find out answers compose, which is the safe default for
 * read-only callers, and is not cached so the next call tries again.
 */
const getOrchestrator: GetOrchestrator = async docker =>
  (await getDecidedOrchestrator(docker)) ?? COMPOSE;

export const isSwarm = async (docker: Readonly<Docker>): Promise<boolean> =>
  (await getOrchestrator(docker)).mode === 'swarm';

export default getOrchestrator;
