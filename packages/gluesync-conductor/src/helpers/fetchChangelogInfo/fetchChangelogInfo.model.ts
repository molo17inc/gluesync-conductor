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
  | { success: true; data: ChangelogResponse }
  | { success: false; error: string };

export type FetchChangelogInfo = (
  imageName: string,
  versionNumber: string,
) => Promise<ChangelogResult>;
