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
}>;

export type UpdateNormalBulk = (
  action: (id: string) => Promise<any>,
  composeJson: RawComposeFile,
  requestIds: readonly string[],
  releaseChannel: ReleaseChannelTypes,
  options?: UpdateNormalBulkOptions,
) => Promise<UpdateNormalBulkResult>;
