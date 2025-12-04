import Docker from 'dockerode';

export type StartUpdatedServicesArgs = (
  docker: Readonly<Docker>,
  updatedIds: ReadonlyArray<string>,
) => Promise<void>;
