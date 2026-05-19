import type Docker from 'dockerode';

export type GetCurrentVersion = (
  docker: Readonly<Docker>,
  composeJson: Readonly<any>,
  serviceId: string,
  dockerReady: boolean,
) => Promise<string | null>;
