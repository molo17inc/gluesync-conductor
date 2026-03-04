import { RawComposeFile } from '../../../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../../../models/conductor.model';

export type PrepareComposeUpdate = (
  composeJson: RawComposeFile,
  requestIds: readonly string[],
  releaseChannel: ReleaseChannelTypes,
) => Promise<readonly string[]>;
