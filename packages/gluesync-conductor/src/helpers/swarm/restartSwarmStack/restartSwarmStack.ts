import { getLogger } from '../../../utils/logger';
import forceUpdateService from '../forceUpdateService/forceUpdateService';
import listStackServices from '../listStackServices/listStackServices';
import waitForServiceConverged from '../waitForServiceConverged/waitForServiceConverged';
import { RestartSwarmStack } from './restartSwarmStack.model';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Restart of the whole stack: every service but the Conductor first, each
 * through a forced update that Swarm rolls out and this waits to converge, then
 * the Conductor, whose own task is replaced and ends this process. A service
 * that fails does not stop the others, nor the Conductor.
 */
const restartSwarmStack: RestartSwarmStack = async (docker, orchestrator) => {
  const { namespace, selfService } = orchestrator;
  const logger = getLogger();

  const services = await listStackServices(docker, namespace);
  const others = services.filter(service => service.id !== selfService);

  const settled = await Promise.allSettled(
    others.map(async service => {
      await forceUpdateService(docker, service.name);
      const converged = await waitForServiceConverged(docker, service.name);

      if (!converged.ok) {
        throw new Error(converged.reason);
      }
    }),
  );

  const results = others.map((service, index) => {
    const outcome = settled[index];

    if (outcome.status === 'fulfilled') {
      return { id: service.id, ok: true };
    }

    logger.error(
      { service: service.id, error: outcome.reason },
      '[swarm] restart of a stack service failed',
    );

    return {
      id: service.id,
      ok: false,
      error: errorMessage(outcome.reason),
    };
  });

  if (!services.some(service => service.id === selfService)) {
    return results;
  }

  logger.info('[swarm] restarting the conductor last');

  try {
    await forceUpdateService(docker, `${namespace}_${selfService}`);

    return [...results, { id: selfService, ok: true }];
  } catch (error) {
    logger.error({ error }, '[swarm] restart of the conductor failed');

    return [
      ...results,
      { id: selfService, ok: false, error: errorMessage(error) },
    ];
  }
};

export default restartSwarmStack;
