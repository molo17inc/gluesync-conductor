import { ReleaseChannelTypes } from '../../../../models/conductor.model';

export type MigrationWithUpdate = (
  requestIds: readonly string[],
  releaseChannel: ReleaseChannelTypes,
  isWindows: boolean,
  helperImageWindows: string,
) => Promise<void>;
