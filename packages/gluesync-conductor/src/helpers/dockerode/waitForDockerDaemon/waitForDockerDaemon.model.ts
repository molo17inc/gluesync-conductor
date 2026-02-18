import type Dockerode from 'dockerode';
import { Logger } from 'pino';

export type WaitForDockerDaemonOptions = Readonly<{
  totalTimeoutMs?: number;
  perAttemptTimeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}>;

export type WaitForDockerDaemon = (
  docker: Readonly<Dockerode>,
  log: Readonly<Logger>,
  opts?: WaitForDockerDaemonOptions,
) => Promise<void>;
