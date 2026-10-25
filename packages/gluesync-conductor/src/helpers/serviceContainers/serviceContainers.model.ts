import type Docker from 'dockerode';

// A service's containers at one moment: their ids and images, as one string
// per service. Two equal fingerprints mean nothing was created or removed.
export type Fingerprints = Readonly<Record<string, string>>;

export type ServiceObservation = Readonly<{
  running: boolean;
  // The image the container was created from, as the compose file names it.
  image: string | null;
  // How the container looks, for messages ("exited", "no container").
  detail: string;
}>;

export type FingerprintServices = (
  docker: Readonly<Docker>,
  ids: ReadonlyArray<string>,
) => Promise<Fingerprints>;

export type ObserveService = (
  docker: Readonly<Docker>,
  id: string,
) => Promise<ServiceObservation>;
