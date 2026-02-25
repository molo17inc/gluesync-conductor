// src/helpers/maven/fetchAllArtifactVersions.ts

import axiosWithRetry from '../../utils/axiosWithRetry';
import { getLogger } from '../../utils/logger';
import {
  MavenSearchResponse,
  MAVEN_NAMESPACE_BY_CHANNEL,
  FetchLatestArtifactVersion,
} from './fetchLatestArtifactVersion.model';

const logger = getLogger();
const BASE_URL = 'https://central.sonatype.com/solrsearch/select';

/**
 * Fetch all artifacts for a given release channel.
 */
const fetchAllArtifactVersions: FetchLatestArtifactVersion =
  async releaseChannel => {
    const namespace = MAVEN_NAMESPACE_BY_CHANNEL[releaseChannel];
    if (!namespace) {
      throw new Error(`Unsupported release channel: ${releaseChannel}`);
    }

    logger.info(
      { namespace, releaseChannel },
      '[fetchAllArtifactVersions] fetching all artifacts from Maven for channel',
    );

    try {
      const data = await axiosWithRetry<MavenSearchResponse>(
        `${BASE_URL}?q=g:${namespace}&rows=100&wt=json`,
        {
          retries: 3,
          timeout: 5000,
          backoffMs: 300,
        },
      );

      const docs = data?.response?.docs ?? [];

      logger.info(
        {
          numFound: data?.response?.numFound,
          artifacts: docs.map(d => d.a),
        },
        '[fetchAllArtifactVersions] received all artifact versions',
      );

      return docs;
    } catch (err) {
      logger.error(
        { error: err, namespace },
        '[fetchAllArtifactVersions] failed to fetch artifact versions',
      );
      throw new Error('Unable to fetch all artifact versions');
    }
  };

export default fetchAllArtifactVersions;
