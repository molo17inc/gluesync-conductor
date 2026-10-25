import waitForDockerDaemon from '../waitForDockerDaemon/waitForDockerDaemon';
import { getLogger } from '../../../utils/logger';
import type { WaitForDockerOutage } from './waitForDockerOutage.model';

const DEFAULT_DOCKER_WAIT_MS = 60000;

/**
 * How long an update waits for a Docker API that dropped (CONDUCTOR_DOCKER_WAIT_MS,
 * default 60 s, 0 disables the wait). Read on every call so it can change at runtime.
 */
export const dockerWaitMs = (): number => {
  const raw = process.env.CONDUCTOR_DOCKER_WAIT_MS;
  const parsed =
    raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_DOCKER_WAIT_MS;
};

/**
 * Resolves once the Docker API answers a ping; rejects (with a transient
 * "not ready" error) when it does not within the budget. An update that meets a
 * Docker outage waits it out instead of failing with whatever is half done.
 */
const waitForDockerOutage: WaitForDockerOutage = async (
  docker,
  budgetMs = dockerWaitMs(),
) => {
  if (budgetMs <= 0) {
    return;
  }
  await waitForDockerDaemon(docker, getLogger(), { totalTimeoutMs: budgetMs });
};

export default waitForDockerOutage;
