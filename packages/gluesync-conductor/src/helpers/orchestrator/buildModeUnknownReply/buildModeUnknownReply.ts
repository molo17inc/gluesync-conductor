import buildDiagnosis from '../../../diagnosis/buildDiagnosis';
import { ErrorResponse } from '../../../models/common.model';

/**
 * 503 for a request that changes services while the Docker daemon is not
 * answering: without knowing compose from swarm, doing anything would risk
 * editing the wrong thing.
 */
const buildModeUnknownReply = (): ErrorResponse => ({
  success: false,
  error: 'Docker is not ready',
  details:
    'Conductor cannot tell yet whether it runs on Docker Compose or Docker Swarm because the Docker daemon is not answering',
  diagnosis: buildDiagnosis({ code: 'DOCKER_NOT_READY' }),
});

export default buildModeUnknownReply;
