import type Docker from 'dockerode';

import { getLogger } from '../../utils/logger';

export type ContainerEngine = Readonly<{
  engine: 'docker' | 'podman';
  rootless: boolean;
  version: string;
}>;

type VersionLike = Readonly<{
  Version?: string;
  Components?: ReadonlyArray<Readonly<{ Name?: string; Version?: string }>>;
}>;

type InfoLike = Readonly<{
  ServerVersion?: string;
  SecurityOptions?: ReadonlyArray<string>;
}>;

const isPodmanComponent = (component?: Readonly<{ Name?: string }>): boolean =>
  /podman engine/i.test(component?.Name ?? '');

/**
 * Which engine answers on the socket: Podman's compat API lists a
 * "Podman Engine" component in `/version`, and both engines put
 * `name=rootless` in the `SecurityOptions` of `/info` when they run rootless.
 */
export const detectContainerEngine = (
  version: VersionLike | undefined,
  info: InfoLike | undefined,
): ContainerEngine => {
  const podman = version?.Components?.find(isPodmanComponent);

  return {
    engine: podman ? 'podman' : 'docker',
    rootless: (info?.SecurityOptions ?? []).some(option =>
      String(option).split(',').includes('name=rootless'),
    ),
    version: podman?.Version ?? version?.Version ?? info?.ServerVersion ?? '',
  };
};

// The engine behind a socket does not change while the process runs
const cache = new Map<string, ContainerEngine>();

export const resetContainerEngineCache = (): void => {
  cache.clear();
};

/**
 * The engine this Conductor talks to, asked once and remembered. `undefined`
 * when the engine cannot be asked (not cached: the next call asks again).
 */
export const getContainerEngine = async (
  docker: Readonly<Docker>,
): Promise<ContainerEngine | undefined> => {
  const cached = cache.get('value');

  if (cached) {
    return cached;
  }

  try {
    const version = (await docker.version()) as VersionLike;
    const info = await docker
      .info()
      .then(answer => answer as InfoLike)
      .catch(() => undefined);
    const engine = detectContainerEngine(version, info);

    // Without /info the rootless flag is a guess: ask again next time
    if (info) {
      cache.set('value', engine);
    }

    return engine;
  } catch (error) {
    getLogger().warn(
      { error },
      '[container-engine] could not tell which engine this is',
    );

    return undefined;
  }
};

export const isPodmanEngine = async (
  docker: Readonly<Docker>,
): Promise<boolean> => (await getContainerEngine(docker))?.engine === 'podman';
