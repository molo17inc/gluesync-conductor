import type Docker from 'dockerode';

export type VerifyServiceStableOptions = Readonly<{
  // How long the container must stay up without restarting.
  windowMs?: number;
  // How long to wait for a container with a healthcheck to report healthy.
  maxWaitMs?: number;
  pollMs?: number;
}>;

export type VerifyServiceStable = (
  docker: Readonly<Docker>,
  serviceId: string,
  options?: VerifyServiceStableOptions,
) => Promise<void>;
