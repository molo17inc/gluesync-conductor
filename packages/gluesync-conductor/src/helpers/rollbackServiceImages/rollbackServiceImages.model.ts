import type Docker from 'dockerode';
import type {
  FingerprintServices,
  Fingerprints,
} from '../serviceContainers/serviceContainers.model';

export type RollbackOutcome = Readonly<{
  id: string;
  image: string;
  ok: boolean;
  error?: string;
  // The compose file went back, but the running container was never touched
  // by the failed update, so it was not recreated.
  untouched?: boolean;
}>;

export type RollbackOptions =
  // Only the compose file goes back (the container keeps running its image).
  | Readonly<{ recreate: false }>
  // The containers are brought back on the old image too, once Docker answers.
  // `before` is what the update set's containers looked like before the update
  // (services whose containers are unchanged are not recreated); `services` is
  // the whole update set, checked at the end: each must be running the image
  // the compose file names.
  | Readonly<{
      recreate: true;
      docker: Readonly<Docker>;
      before?: Fingerprints;
      services: ReadonlyArray<string>;
      // The services are Swarm services of this stack: the containers are put
      // back through the Swarm API instead of `compose up`.
      swarm?: Readonly<{ namespace: string }>;
    }>;

// A service that is not as the stack or compose file says.
export type Broken = Readonly<{ id: string; reason: string }>;

// What differs between the orchestrators when a failed update is undone.
export type RestoreStrategy = Readonly<{
  // The state of the services before and after the update, to tell the ones it
  // touched.
  fingerprint: FingerprintServices;
  // Brings a service to the image the file names; resolves to the failure.
  bringUp: (
    docker: Readonly<Docker>,
    id: string,
  ) => Promise<string | undefined>;
  // Why the service is not running the file's image (null when it is).
  problemWith: (
    docker: Readonly<Docker>,
    id: string,
    image?: string,
  ) => Promise<Broken | null>;
}>;

export type RollbackServiceImages = (
  rollbacks: ReadonlyArray<Readonly<{ id: string; image: string }>>,
  options: RollbackOptions,
) => Promise<ReadonlyArray<RollbackOutcome>>;
