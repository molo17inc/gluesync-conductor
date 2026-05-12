import axiosWithRetry from '../../utils/axiosWithRetry';
import { getLogger } from '../../utils/logger';
import {
  ChangelogResponse,
  FetchChangelogInfo,
} from './fetchChangelogInfo.model';

const logger = getLogger();

const fetchChangelogInfo: FetchChangelogInfo = async (
  imageName,
  versionNumber,
) => {
  logger.info(
    { imageName, versionNumber },
    '[fetchChangelogInfo] fetching changelog from backoffice',
  );

  try {
    const data = await axiosWithRetry<ChangelogResponse>(
      `https://api.backoffice.molo17.com/changelog/${imageName}/${versionNumber}`,
      {
        retries: 3,
        timeout: 5000,
        backoffMs: 300,
      },
    );

    logger.info(
      { imageName, versionNumber },
      '[fetchChangelogInfo] received changelog info',
    );

    return data;
  } catch (error) {
    logger.warn(
      { imageName, versionNumber, error },
      '[fetchChangelogInfo] failed to fetch changelog',
    );

    throw new Error('Unable to fetch changelog info');
  }
};

export default fetchChangelogInfo;
