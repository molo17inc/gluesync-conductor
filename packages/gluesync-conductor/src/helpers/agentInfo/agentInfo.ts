import axios from 'axios';
import { AgentInfoResponse } from './agentInfo.model';

const fetchAgentInfo = async (
  imageName: string,
): Promise<AgentInfoResponse> => {
  try {
    const response = await axios.get(
      `https://api.backoffice.molo17.com/agent/${imageName}/version`,
    );
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw error; // Throw because it contains HTTP status in error.response
    }
    throw new Error(`Failed to fetch agent info from backoffice: ${imageName}`);
  }
};

export default fetchAgentInfo;
