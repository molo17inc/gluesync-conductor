import type Dockerode from 'dockerode';

export type WaitForDockerOutage = (
  docker: Readonly<Dockerode>,
  budgetMs?: number,
) => Promise<void>;
