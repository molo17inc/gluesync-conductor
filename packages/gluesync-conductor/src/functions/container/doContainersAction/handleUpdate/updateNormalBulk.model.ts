import { RawComposeFile } from '../../../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../../../models/conductor.model';

export interface UpdateNormalBulkResult {
  orderedIds: readonly string[];
  results: PromiseSettledResult<any>[];
}

export type UpdateNormalBulk = (
  action: (id: string) => Promise<any>,
  composeJson: RawComposeFile,
  requestIds: readonly string[],
  releaseChannel: ReleaseChannelTypes,
) => Promise<UpdateNormalBulkResult>;
