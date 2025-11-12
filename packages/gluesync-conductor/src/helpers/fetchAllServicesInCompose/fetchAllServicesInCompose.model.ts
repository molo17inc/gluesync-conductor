import { RawComposeFile } from '../../models/composeFile.model';

export type FetchAllServicesInCompose = (
  composeJson: RawComposeFile,
  reorder: boolean,
) => ReadonlyArray<string>;

export const EXCLUDED_SERVICES = new Set([
  'reverse-proxy',
  'grafana',
  'prometheus',
  'portainer',
]);
