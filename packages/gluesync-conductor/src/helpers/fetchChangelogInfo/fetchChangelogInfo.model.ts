import { ErrorResponse, SuccessResponse } from '../../models/common.model';

export type ChangelogResponse = {
  id: number;
  versionNumber: string;
  releaseDate: string;
  changelog: string;
  changelogSummary: string | null;
  module: string;
  relativePath: string | null;
};

export type ChangelogResult =
  | SuccessResponse<ChangelogResponse>
  | ErrorResponse;

export type FetchChangelogInfo = (
  imageName: string,
  versionNumber: string,
) => Promise<ChangelogResult>;
