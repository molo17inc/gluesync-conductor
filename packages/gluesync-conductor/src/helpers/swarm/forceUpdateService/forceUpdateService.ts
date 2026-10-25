import { getLogger } from '../../../utils/logger';
import updateServiceSpec from '../updateServiceSpec/updateServiceSpec';
import { ForceUpdateService } from './forceUpdateService.model';

// Bumping `ForceUpdate` changes the task template, so Swarm replaces every
// task even though nothing else changed: this is the restart.
const forceUpdateService: ForceUpdateService = async (docker, fullName) => {
  const before = await updateServiceSpec(docker, fullName, spec => ({
    ...spec,
    TaskTemplate: {
      ...spec.TaskTemplate,
      ForceUpdate: (spec.TaskTemplate?.ForceUpdate ?? 0) + 1,
    },
  }));

  getLogger().info({ service: fullName }, '[swarm] forced service update');

  return before;
};

export default forceUpdateService;
