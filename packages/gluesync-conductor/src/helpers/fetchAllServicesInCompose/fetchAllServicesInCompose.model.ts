import { RawComposeFile } from '../../models/composeFile.model';

export type FetchAllServicesInCompose = (
  composeJson: RawComposeFile,
  reorder: boolean,
) => ReadonlyArray<string>;
