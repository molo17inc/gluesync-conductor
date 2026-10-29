import buildDiagnosis from '../../../diagnosis/buildDiagnosis';
import { ErrorResponse } from '../../../models/common.model';

/**
 * 501 for the v2 migration on Docker Swarm: it stops agents, moves their data
 * and restarts the stack by hand, none of which has a Swarm equivalent.
 */
const buildMigrationRefusedOnSwarmReply = (): ErrorResponse => ({
  success: false,
  error: 'Migration to 2.x is not available on Docker Swarm',
  details:
    'The migration to 2.x is not supported when Gluesync runs as a Docker Swarm stack',
  diagnosis: buildDiagnosis({
    code: 'SWARM_UNSUPPORTED',
    params: { feature: 'migration-to-v2' },
  }),
});

export default buildMigrationRefusedOnSwarmReply;
