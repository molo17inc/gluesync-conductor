import { ComposeFile, RawComposeFile } from '../../../models/composeFile.model';

export type ReadComposeFile = (
  filename?: string,
  options?: { raw?: boolean },
) => Promise<Partial<RawComposeFile | ComposeFile>>;
