import Dockerode from 'dockerode';

export type WaitForContainerReady = (
  docker: Readonly<Dockerode>,
  containerName: string,
  maxRetries?: number,
  delayMs?: number,
) => Promise<void>;
