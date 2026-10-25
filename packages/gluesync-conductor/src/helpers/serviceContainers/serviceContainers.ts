import type Docker from 'dockerode';
import { LabelPrefix } from '../../models/composeFile.model';
import type {
  FingerprintServices,
  ObserveService,
} from './serviceContainers.model';

const containersOf = (
  docker: Readonly<Docker>,
  id: string,
): Promise<Docker.ContainerInfo[]> =>
  docker.listContainers({
    all: true,
    filters: { label: [`${LabelPrefix.COMPOSE}.service=${id}`] },
  });

/**
 * What the containers of these services are right now: used before an update to
 * tell later which services it actually touched (a container that was created
 * or removed has a different fingerprint). One Docker call per service.
 */
export const fingerprintServices: FingerprintServices = async (docker, ids) => {
  const entries = await Promise.all(
    ids.map(async id => {
      const list = await containersOf(docker, id);
      const fingerprint = list
        .map(c => `${c.Id}@${c.ImageID}`)
        .sort((a, b) => a.localeCompare(b))
        .join(',');
      return [id, fingerprint] as const;
    }),
  );
  return Object.fromEntries(entries);
};

/**
 * Whether the service has a running container and which image it came from.
 * With a half-done recreate (new container created but never started, old one
 * exited) the newest container is the one that counts.
 */
export const observeService: ObserveService = async (docker, id) => {
  const list = await containersOf(docker, id);
  const newest = [...list].sort((a, b) => b.Created - a.Created)[0];
  const container = list.find(c => c.State === 'running') ?? newest;
  if (!container) {
    return { running: false, image: null, detail: 'no container' };
  }
  const { State, Config } = await docker.getContainer(container.Id).inspect();
  const state = State.Restarting ? 'restarting' : State.Status;
  return {
    running: State.Running === true && !State.Restarting,
    image: Config.Image,
    detail: state,
  };
};
