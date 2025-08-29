import { RawComposeFile } from '../../models/composeFile.model';

export type EditUpdateImagesInComposeFile = (
  containerIds: ReadonlyArray<string>,
  composeJson: RawComposeFile,
  latestVersionGA: string,
) => Promise<void>;
