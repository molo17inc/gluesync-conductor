import type Docker from 'dockerode';

import { getDecidedOrchestrator } from '../orchestrator/getOrchestrator/getOrchestrator';
import type { Orchestrator } from '../orchestrator/getOrchestrator/getOrchestrator.model';
import { ContainerEngine, getContainerEngine } from './containerEngine';

/**
 * Which environment manages this Gluesync installation, as CoreHub receives
 * it in the `Module-Environment` header of the `/ext-module` handshake. The
 * Gluesync Kubernetes Operator sends `gko` the same way.
 */
export type ManagedEnvironment =
  | 'conductor-docker'
  | 'conductor-podman'
  | 'conductor-swarm';

export const MANAGED_ENVIRONMENT_HEADER = 'Module-Environment';

/**
 * Podman has no Swarm, so it is told by the engine alone; on Docker the
 * orchestrator the Conductor actually runs (a stack service or Compose)
 * decides. `undefined` when what is needed is unknown: never a guess.
 */
export const toManagedEnvironment = (
  engine: ContainerEngine | undefined,
  orchestrator: Orchestrator | undefined,
): ManagedEnvironment | undefined => {
  if (engine?.engine === 'podman') {
    return 'conductor-podman';
  }

  if (!engine || !orchestrator) {
    return undefined;
  }

  return orchestrator.mode === 'swarm' ? 'conductor-swarm' : 'conductor-docker';
};

/**
 * The environment, asked of the engine (`/version`, `/info`) and of the
 * Conductor's own container labels; both answers are cached once known.
 */
export const getManagedEnvironment = async (
  docker: Readonly<Docker>,
): Promise<ManagedEnvironment | undefined> => {
  const engine = await getContainerEngine(docker);

  if (engine?.engine === 'podman') {
    return 'conductor-podman';
  }

  return toManagedEnvironment(engine, await getDecidedOrchestrator(docker));
};

/**
 * The handshake headers for CoreHub: none until the environment is known.
 */
export const managedEnvironmentHeaders = (
  environment: ManagedEnvironment | undefined,
): Readonly<Record<string, string>> =>
  environment ? { [MANAGED_ENVIRONMENT_HEADER]: environment } : {};

// How long the first connection to CoreHub waits for the engine to answer
export const ENVIRONMENT_WAIT_MS = 1500;

type HeaderTarget = Readonly<{
  setExtraHeaders: (provider: () => Readonly<Record<string, string>>) => void;
}>;

/**
 * Has the SDK client send `Module-Environment` on every connection to
 * CoreHub. Returns a promise that settles once the environment is known or
 * after `waitMs`, whichever is first, so the first connection can carry it
 * without ever being held up by an engine that does not answer. Until it is
 * known, every connection asks again in the background, and the next one
 * sends it.
 */
export const reportManagedEnvironment = (
  client: HeaderTarget,
  docker: () => Readonly<Docker>,
  waitMs: number = ENVIRONMENT_WAIT_MS,
): Promise<void> => {
  const known = new Map<'value', ManagedEnvironment>();
  const inFlight = new Map<'current', Promise<void>>();

  const detect = (): Promise<void> => {
    const running = inFlight.get('current');
    if (running) {
      return running;
    }
    const attempt = Promise.resolve()
      .then(() => getManagedEnvironment(docker()))
      .then(
        environment => {
          if (environment) {
            known.set('value', environment);
          }
        },
        () => undefined,
      )
      .finally(() => inFlight.delete('current'));
    inFlight.set('current', attempt);
    return attempt;
  };

  client.setExtraHeaders(() => {
    const environment = known.get('value');
    if (!environment) {
      detect().catch(() => undefined);
    }
    return managedEnvironmentHeaders(environment);
  });

  return Promise.race([
    detect(),
    new Promise<void>(resolve => {
      setTimeout(resolve, waitMs).unref?.();
    }),
  ]);
};
