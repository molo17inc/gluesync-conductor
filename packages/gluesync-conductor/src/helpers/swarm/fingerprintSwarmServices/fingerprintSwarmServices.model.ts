import type Docker from 'dockerode';

import type { Fingerprints } from '../../serviceContainers/serviceContainers.model';

export type FingerprintSwarmServices = (
  docker: Readonly<Docker>,
  namespace: string,
  ids: ReadonlyArray<string>,
) => Promise<Fingerprints>;
