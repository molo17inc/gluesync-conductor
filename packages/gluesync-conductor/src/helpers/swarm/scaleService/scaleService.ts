import { getLogger } from '../../../utils/logger';
import updateServiceSpec from '../updateServiceSpec/updateServiceSpec';
import { ScaleService } from './scaleService.model';

const scaleService: ScaleService = async (docker, fullName, replicas) => {
  const before = await updateServiceSpec(docker, fullName, spec => {
    if (!spec.Mode?.Replicated) {
      throw new Error(`${fullName} is not a replicated service, cannot scale`);
    }

    return {
      ...spec,
      Mode: { ...spec.Mode, Replicated: { Replicas: replicas } },
    };
  });

  getLogger().info(
    { service: fullName, from: before.replicas, to: replicas },
    '[swarm] scaled service',
  );

  return before;
};

export default scaleService;
