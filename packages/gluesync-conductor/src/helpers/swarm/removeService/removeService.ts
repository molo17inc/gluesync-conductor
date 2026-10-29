import { getLogger } from '../../../utils/logger';
import { RemoveService } from './removeService.model';

const removeService: RemoveService = async (docker, fullName) => {
  await docker.getService(fullName).remove();

  getLogger().info({ service: fullName }, '[swarm] removed service');
};

export default removeService;
