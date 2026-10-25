import waitForDockerOutage, {
  dockerWaitMs,
} from '../waitForDockerOutage/waitForDockerOutage';
import type { WaitForDockerPreflight } from './waitForDockerPreflight.model';

// How long a preflight check waits for the Docker API before an update starts
// (the full CONDUCTOR_DOCKER_WAIT_MS is for outages in the middle of one).
export const PREFLIGHT_MAX_MS = 15000;

/**
 * Nothing is touched while the Docker API is down: an update fails early, with
 * an error that says so, instead of halfway through.
 */
const waitForDockerPreflight: WaitForDockerPreflight = docker =>
  waitForDockerOutage(docker, Math.min(dockerWaitMs(), PREFLIGHT_MAX_MS));

export default waitForDockerPreflight;
