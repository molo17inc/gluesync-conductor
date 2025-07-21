import { ComposeFile } from '../../models/composeFile.model';

export type ReadComposeFile = (
  filename?: string,
) => Promise<Record<string, Partial<ComposeFile>> | undefined>;
