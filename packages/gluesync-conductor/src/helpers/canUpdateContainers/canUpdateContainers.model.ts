import { RawComposeFile } from '../../models/composeFile.model';

export type CanUpdateContainers = (
  containerIds: ReadonlyArray<string>,
  composeJson: RawComposeFile,
) => Promise<{
  success: boolean;
  errors: (string | null)[];
  message: string;
  data?: string;
}>;
