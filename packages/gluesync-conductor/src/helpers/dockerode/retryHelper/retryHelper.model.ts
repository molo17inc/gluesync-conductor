import { IDockerComposeResult } from 'docker-compose';
import { Logger } from 'pino';

export type RetryCmd = (
  attempt: number,
  maxRetries: number,
  fn: () => Promise<unknown>,
  logger: Readonly<Logger>,
  id?: string,
) => Promise<IDockerComposeResult>;
