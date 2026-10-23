import { RawComposeFile } from '../../../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../../../models/conductor.model';

export type PrepareComposeUpdate = (
  composeJson: RawComposeFile,
  requestIds: readonly string[],
  releaseChannel: ReleaseChannelTypes,
) => Promise<
  Readonly<{
    effectiveIds: readonly string[];
    // Requested services left out of this update, with the reason.
    skipped: ReadonlyArray<Readonly<{ id: string; reason: string }>>;
  }>
>;
