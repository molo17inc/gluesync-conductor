import { ComposeFile } from '../../../models/composeFile.model';

export type ReadComposeFile = (
  filename?: string,
) => Promise<Partial<ComposeFile> | undefined>;
