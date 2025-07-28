import { RawComposeFile } from '../../../models/composeFile.model';

export type ReadComposeFile = (
  filename?: string,
) => Promise<Partial<RawComposeFile> | undefined>;
