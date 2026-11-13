import { RawComposeFile } from '../../../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../../../models/conductor.model';

export type PrepareComposeUpdate = (
  composeJson: RawComposeFile,
  requestIds: readonly string[],
  releaseChannel: ReleaseChannelTypes,
  options?: Readonly<{
    swarm?: boolean;
    // Runs once the services to update are known, before the compose/stack
    // file is written: the update stops here, nothing changed, if it throws
    beforeImagesChange?: (effectiveIds: readonly string[]) => Promise<void>;
  }>,
) => Promise<
  Readonly<{
    effectiveIds: readonly string[];
    // Requested services left out of this update, with the reason.
    skipped: ReadonlyArray<Readonly<{ id: string; reason: string }>>;
  }>
>;
