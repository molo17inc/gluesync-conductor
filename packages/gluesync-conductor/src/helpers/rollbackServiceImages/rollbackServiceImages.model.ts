import type Docker from 'dockerode';
import type { Fingerprints } from '../serviceContainers/serviceContainers.model';

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
    }>;

export type RollbackServiceImages = (
  rollbacks: ReadonlyArray<Readonly<{ id: string; image: string }>>,
  options: RollbackOptions,
) => Promise<ReadonlyArray<RollbackOutcome>>;
