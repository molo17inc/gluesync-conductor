export type HandleGrafanaEmbeddedDashboardResult = Readonly<{
  applied: boolean;
  serviceId: string;
}>;

export type HandleGrafanaEmbeddedDashboard =
  () => Promise<HandleGrafanaEmbeddedDashboardResult>;
