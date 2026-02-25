import { ReleaseChannelTypes } from '../../models/conductor.model';

export type MavenArtifactDoc = {
  id: string;
  g: string;
  a: string;
  latestVersion: string;
  repositoryId: string;
  p: string;
  timestamp: number;
  versionCount: number;
  ec: string[];
};

export type FetchLatestArtifactVersion = (
  releaseChannel: ReleaseChannelTypes,
) => Promise<MavenArtifactDoc[]>;

export type MavenSearchResponse = {
  responseHeader: {
    status: number;
    QTime: number;
    params: Record<string, string>;
  };
  response: {
    numFound: number;
    start: number;
    docs: MavenArtifactDoc[];
  };
  spellcheck: {
    suggestions: unknown[];
  };
};

export const MAVEN_NAMESPACE_BY_CHANNEL: Record<ReleaseChannelTypes, string> = {
  ga: 'com.molo17.gluesync.ga',
  beta: 'com.molo17.gluesync.beta',
  alpha: 'com.molo17.gluesync.alpha',
  // internal: 'com.molo17.gluesync.internal',
};
