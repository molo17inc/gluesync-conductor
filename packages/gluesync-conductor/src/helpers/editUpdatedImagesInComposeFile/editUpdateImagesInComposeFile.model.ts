import { RawComposeFile } from '../../models/composeFile.model';

export type EditUpdateImagesInComposeFile = (
  containerIds: ReadonlyArray<string>,
  composeJson: RawComposeFile,
  versions: Readonly<{
    agentVersion: string | null;
    modules: ReadonlyArray<{ id: string; version: string | null }>;
  }>,
) => Promise<void>;
