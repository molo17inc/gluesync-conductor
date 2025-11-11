import { RawComposeFile } from '../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../models/conductor.model';

export type CanUpdateContainers = (
  containerIds: ReadonlyArray<string>,
  composeJson: RawComposeFile,
  releaseChannel: ReleaseChannelTypes,
) => Promise<{
  success: boolean;
  errors: (string | null)[];
  message: string;
  data?: Readonly<{
    agentVersion: string | null;
    modules: ReadonlyArray<{
      id: string;
      version: string | null;
    }>;
  }>;
}>;
