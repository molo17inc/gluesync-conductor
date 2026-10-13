import { LabelPrefix } from '../../models/composeFile.model';
import { getLogger } from '../../utils/logger';
import { VerifyServiceStable } from './verifyServiceStable.model';

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const envMs = (name: string, fallbackSeconds: number): number => {
  const raw = Number(process.env[name]);
  return (Number.isFinite(raw) && raw >= 0 ? raw : fallbackSeconds) * 1000;
};

type Observation = Readonly<{
  state: string;
  restartCount: number;
  health: string | null;
  exitCode: number;
}>;

/**
 * `docker compose up -d` succeeds as soon as the container is created, even if
 * the new image crashes a second later. This waits until the service's
 * container has stayed running (and healthy, when it has a healthcheck) for a
 * while, and throws with what went wrong otherwise.
 *
 * UPDATE_VERIFY_SECONDS (default 20, 0 disables) sets the window and
 * UPDATE_VERIFY_MAX_WAIT_SECONDS (default 180) bounds the wait for "healthy".
 */
const verifyServiceStable: VerifyServiceStable = async (
  docker,
  serviceId,
  options,
) => {
  const windowMs = options?.windowMs ?? envMs('UPDATE_VERIFY_SECONDS', 20);
  if (windowMs === 0) {
    return;
  }
  const maxWaitMs =
    options?.maxWaitMs ?? envMs('UPDATE_VERIFY_MAX_WAIT_SECONDS', 180);
  const pollMs = options?.pollMs ?? 2000;
  const logger = getLogger();
  const started = Date.now();

  const observe = async (): Promise<Observation | null> => {
    const list = await docker.listContainers({
      all: true,
      filters: { label: [`${LabelPrefix.COMPOSE}.service=${serviceId}`] },
    });
    const container = list.find(c => c.State === 'running') ?? list[0];
    if (!container) {
      return null;
    }
    const inspect = await docker.getContainer(container.Id).inspect();
    return {
      state: inspect.State.Restarting ? 'restarting' : inspect.State.Status,
      restartCount: inspect.RestartCount,
      health: inspect.State.Health?.Status ?? null,
      exitCode: inspect.State.ExitCode,
    };
  };

  const describe = (o: Observation): string => {
    const health = o.health ? `/${o.health}` : '';
    return `${o.state}${health}, exit code ${o.exitCode}, restarts ${o.restartCount}`;
  };

  const poll = async (
    baseline: number | null,
    stableSince: number | null,
  ): Promise<void> => {
    const elapsed = Date.now() - started;
    const o = await observe();

    if (!o) {
      throw new Error(`no container found for ${serviceId} after the update`);
    }
    const base = baseline ?? o.restartCount;
    if (
      o.restartCount > base ||
      ['restarting', 'exited', 'dead'].includes(o.state)
    ) {
      throw new Error(
        `${serviceId} is not staying up after the update (${describe(o)})`,
      );
    }
    if (o.health === 'unhealthy') {
      throw new Error(
        `${serviceId} is unhealthy after the update (${describe(o)})`,
      );
    }

    const healthyEnough =
      o.state === 'running' && (!o.health || o.health === 'healthy');
    const since = healthyEnough ? (stableSince ?? Date.now()) : null;
    if (since !== null && Date.now() - since >= windowMs) {
      logger.info(
        { service: serviceId, waitedMs: elapsed },
        '[update-verify] service is up and stable',
      );
      return;
    }
    if (elapsed >= maxWaitMs) {
      throw new Error(
        `${serviceId} did not become ready within ${Math.round(maxWaitMs / 1000)}s after the update (${describe(o)})`,
      );
    }
    await sleep(pollMs);
    await poll(base, since);
  };

  await poll(null, null);
};

export default verifyServiceStable;
