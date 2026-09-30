import { upAll } from 'docker-compose';

import { getLogger } from '../../utils/logger';
import { runCmd } from '../dockerode/createActions/createActions';
import { restartProxyContainer } from '../healTraefikConf/healTraefikConf';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

/**
 * Recreate Chronos so Docker picks up the rewritten Traefik label.
 * A restart is not enough: router rules are container labels.
 * Same recreate shape as the Grafana embedded-dashboard heal
 * (`up -d --force-recreate --no-deps`), without removing volumes.
 * Then restart the reverse-proxy so Traefik reloads the Chronos router.
 */
const recreateChronosContainers = async (
  serviceNames: readonly string[],
  proxyServiceName: string | null,
): Promise<void> => {
  const logger = getLogger();

  const recreated = await Promise.all(
    serviceNames.map(async serviceName => {
      try {
        await runCmd(upAll, serviceName, dkrComposeFile, [
          '--force-recreate',
          '--no-deps',
        ]);

        logger.info(`[chronos-traefik-healer] recreated ${serviceName}`);

        return true;
      } catch (error) {
        logger.error(
          { error },
          `[chronos-traefik-healer] failed to recreate ${serviceName}`,
        );

        return false;
      }
    }),
  );

  if (!recreated.some(Boolean)) {
    return;
  }

  if (!proxyServiceName) {
    logger.info(
      '[chronos-traefik-healer] no reverse-proxy service found, skipping restart',
    );
    return;
  }

  try {
    await restartProxyContainer(proxyServiceName);
  } catch (error) {
    logger.error(
      { error },
      `[chronos-traefik-healer] failed to restart ${proxyServiceName}`,
    );
  }
};

export default recreateChronosContainers;
