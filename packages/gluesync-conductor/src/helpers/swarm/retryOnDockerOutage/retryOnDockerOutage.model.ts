import type Docker from 'dockerode';

export type RetryOnDockerOutage = <T>(
  docker: Readonly<Docker>,
  what: string,
  call: () => Promise<T>,
  attemptsLeft?: number,
) => Promise<T>;
