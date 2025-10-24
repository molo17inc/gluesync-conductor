import Docker from 'dockerode';

export type CleanupOrphanNetworkByName = (
  docker: Readonly<Docker>,
  networkName: Readonly<string>,
) => Promise<string>;
