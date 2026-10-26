import type Dockerode from 'dockerode';

export type WaitForDockerPreflight = (
  docker: Readonly<Dockerode>,
) => Promise<void>;
