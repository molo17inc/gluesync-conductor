import { getLogger } from '../../../utils/logger';
import updateServiceSpec from '../updateServiceSpec/updateServiceSpec';
import { RollbackService } from './rollbackService.model';

// `docker service rollback` is this same call: the update endpoint with
// `rollback=previous` and the current spec, Swarm swaps in the PreviousSpec.
const rollbackService: RollbackService = async (docker, fullName) => {
  const before = await updateServiceSpec(
    docker,
    fullName,
    (spec, current) => {
      // Otherwise the API answers with a vague 500
      if (!current.previousSpec) {
        throw new Error(`${fullName} has no previous version to roll back to`);
      }

      return spec;
    },
    { query: { rollback: 'previous' } },
  );

  getLogger().info(
    { service: fullName, from: before.image },
    '[swarm] rolled service back to its previous spec',
  );

  return before;
};

export default rollbackService;
