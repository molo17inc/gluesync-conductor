// src/helpers/agentInfo/agentInfo.ts
import axios from 'axios';
import axiosWithRetry from '../../utils/axiosWithRetry';
import { AgentInfoResponse } from './agentInfo.model';
import { ImageNotPublishedError } from './agentInfo.errors';
import { getLogger } from '../../utils/logger';

const logger = getLogger();

const fetchAgentInfo = async (
  imageName: string,
): Promise<AgentInfoResponse> => {
  logger.info(
    { imageName },
    '[fetchAgentInfo] fetching agent info from backoffice',
  );

  try {
    const data = await axiosWithRetry<AgentInfoResponse>(
      `https://api.backoffice.molo17.com/agent/${imageName}/version`,
      {
        retries: 3,
        timeout: 5000,
        backoffMs: 300,
      },
    );

    logger.info(
      {
        imageName,
        latestVersionGA: data?.latestVersionGA,
        latestVersionBeta: data?.latestVersionBeta,
        latestVersionAlpha: data?.latestVersionAlpha,
      },
      '[fetchAgentInfo] received agent info',
    );

    return data;
  } catch (error) {
    // A 404 is the backoffice's answer, not a failure: the image is not one
    // it publishes. Callers stop asking about it instead of treating it as an
    // outage.
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      logger.warn(
        { imageName },
        '[fetchAgentInfo] the backoffice does not publish this image',
      );

      throw new ImageNotPublishedError(imageName);
    }

    logger.error(
      { imageName, error },
      '[fetchAgentInfo] failed to fetch agent info',
    );

    throw error;
  }
};

export default fetchAgentInfo;
