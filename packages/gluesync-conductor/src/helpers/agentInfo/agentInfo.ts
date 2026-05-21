// src/helpers/agentInfo/agentInfo.ts
import axiosWithRetry from '../../utils/axiosWithRetry';
import { AgentInfoResponse } from './agentInfo.model';
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
    logger.error(
      { imageName, error },
      '[fetchAgentInfo] failed to fetch agent info',
    );

    throw error;
  }
};

export default fetchAgentInfo;
