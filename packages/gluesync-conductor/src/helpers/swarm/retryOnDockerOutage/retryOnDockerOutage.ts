import describeFailure from '../../describeFailure/describeFailure';
import isTransientDockerConnError from '../../dockerode/isTransientDockerConnError/isTransientDockerConnError';
import waitForDockerOutage from '../../dockerode/waitForDockerOutage/waitForDockerOutage';
import { getLogger } from '../../../utils/logger';
import { RetryOnDockerOutage } from './retryOnDockerOutage.model';

// A dropped Docker API is waited out this many times before the error stands.
const DOCKER_OUTAGES_TOLERATED = 3;

/**
 * Runs one Docker call (an API call or the `docker` CLI) and, when it fails
 * because the Docker API dropped, waits for the API (CONDUCTOR_DOCKER_WAIT_MS)
 * and tries again. Any other failure (a bad image, a missing service) is final,
 * and so is a Docker that does not come back within the wait.
 *
 * The call must be safe to run again: swarm updates are expressed as a function
 * of the spec they find, so an update that landed before the connection broke
 * finds nothing left to do.
 */
const retryOnDockerOutage: RetryOnDockerOutage = async (
  docker,
  what,
  call,
  attemptsLeft = DOCKER_OUTAGES_TOLERATED,
) => {
  try {
    return await call();
  } catch (error) {
    if (attemptsLeft <= 1 || !isTransientDockerConnError(error)) {
      throw error;
    }

    getLogger().warn(
      { what, error: describeFailure(error) },
      '[swarm] Docker did not answer, waiting for it',
    );
    await waitForDockerOutage(docker);

    return retryOnDockerOutage(docker, what, call, attemptsLeft - 1);
  }
};

export default retryOnDockerOutage;
