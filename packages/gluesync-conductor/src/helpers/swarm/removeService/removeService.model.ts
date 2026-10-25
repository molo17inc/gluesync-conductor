import type Docker from 'dockerode';

export type RemoveService = (
  docker: Readonly<Docker>,
  fullName: string,
) => Promise<void>;
