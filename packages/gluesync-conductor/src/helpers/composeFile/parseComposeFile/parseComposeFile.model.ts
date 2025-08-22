import { ComposeFile, RawComposeFile } from '../../../models/composeFile.model';

export type ParseComposeFile = (
  composeFile: RawComposeFile,
) => Partial<ComposeFile>;
