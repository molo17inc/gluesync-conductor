import type Docker from 'dockerode';

export type HandleGrafanaEmbeddedDashboardResult = Readonly<{
  applied: boolean;
  serviceId: string;
}>;

export type HandleGrafanaEmbeddedDashboardOptions = Readonly<{
  // Given on Docker Swarm, where the service is changed through the Swarm API
  // and never through docker compose
  swarm?: Readonly<{ docker: Readonly<Docker>; namespace: string }>;
}>;

export type HandleGrafanaEmbeddedDashboard = (
  options?: HandleGrafanaEmbeddedDashboardOptions,
) => Promise<HandleGrafanaEmbeddedDashboardResult>;
