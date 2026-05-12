export type ChangelogResponse = Readonly<{
  id: number;
  versionNumber: string;
  releaseDate: string;
  changelog: string;
  changelogSummary: string | null;
  module: string;
  relativePath: string | null;
}>;

export type FetchChangelogInfo = (
  imageName: string,
  versionNumber: string,
) => Promise<ChangelogResponse>;
