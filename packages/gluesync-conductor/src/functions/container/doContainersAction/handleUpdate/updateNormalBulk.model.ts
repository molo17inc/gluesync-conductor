import type Docker from 'dockerode';
import { RawComposeFile } from '../../../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../../../models/conductor.model';

export interface UpdateNormalBulkResult {
  orderedIds: readonly string[];
  results: PromiseSettledResult<any>[];
}

export type UpdateNormalBulkOptions = Readonly<{
  // The update action already put a failed service back on Swarm: only the
  // stack file has to follow
  swarm?: boolean;
  // Where the containers are looked at (before the update and when rolling
  // back on compose); without it a rollback only restores the compose file
  docker?: Readonly<Docker>;
}>;

export type UpdateNormalBulk = (
  action: (id: string) => Promise<any>,
  composeJson: RawComposeFile,
  requestIds: readonly string[],
  releaseChannel: ReleaseChannelTypes,
  options?: UpdateNormalBulkOptions,
) => Promise<UpdateNormalBulkResult>;
