import { RawComposeFile } from '../../models/composeFile.model';

export type FetchAllServicesInCompose = (
  composeJson: RawComposeFile,
  reorder: boolean,
  includeThirdParty?: boolean,
) => ReadonlyArray<string>;

export const THIRD_PARTY_SERVICES = new Set([
  'reverse-proxy',
  'grafana',
  'prometheus',
  'portainer',
]);
