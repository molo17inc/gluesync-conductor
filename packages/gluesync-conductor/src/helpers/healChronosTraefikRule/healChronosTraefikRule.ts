import { upAll } from 'docker-compose';

import { getLogger } from '../../utils/logger';
import { runCmd } from '../dockerode/createActions/createActions';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

/**
 * Recreate Chronos so Docker picks up the rewritten Traefik label.
 * A restart is not enough: router rules are container labels.
 * Same recreate shape as the Grafana embedded-dashboard heal
 * (`up -d --force-recreate --no-deps`), without removing volumes.
 */
const recreateChronosContainers = async (
  serviceNames: readonly string[],
): Promise<void> => {
  const logger = getLogger();

  await Promise.all(
    serviceNames.map(async serviceName => {
      try {
        await runCmd(upAll, serviceName, dkrComposeFile, [
          '--force-recreate',
          '--no-deps',
        ]);

        logger.info(
          `[chronos-traefik-healer] recreated ${serviceName}`,
        );
      } catch (error) {
        logger.error(
          { error },
          `[chronos-traefik-healer] failed to recreate ${serviceName}`,
        );
      }
    }),
  );
};

export default recreateChronosContainers;
