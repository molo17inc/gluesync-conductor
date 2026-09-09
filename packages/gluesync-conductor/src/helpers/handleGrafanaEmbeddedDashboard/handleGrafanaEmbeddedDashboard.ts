import { rm, upAll } from 'docker-compose';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import { runCmd } from '../dockerode/createActions/createActions';
import parseImage from '../parseImage/parseImage';
import removeKey from '../removeKey/removeKey';
import { getLogger } from '../../utils/logger';
import { HandleGrafanaEmbeddedDashboard } from './handleGrafanaEmbeddedDashboard.model';

const GRAFANA_SERVICE = 'grafana';
const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

/**
 * Detects the new grafana image that ships embedded dashboards/datasources
 * (image tag contains the `dashboard` marker, e.g. `molo17/grafana:13.0.2.dashboard1`).
 *
 * When detected AND the grafana service still has host bind mounts that would
 * shadow the image's baked-in provisioning, this helper:
 *   1. Removes ALL grafana volume mounts from the compose file.
 *   2. Recreates the grafana container with volume removal
 *      (`docker compose rm -s -v grafana` then `up -d --force-recreate --no-deps grafana`).
 *
 * Idempotent: a no-op when the grafana service is missing, the image tag does
 * not contain `dashboard`, or the volumes have already been removed.
 */
const handleGrafanaEmbeddedDashboard: HandleGrafanaEmbeddedDashboard =
  async () => {
    const logger = getLogger();

    const composeJson = await readComposeFile({ raw: true });
    const service = composeJson.services?.[GRAFANA_SERVICE];

    if (!service) {
      logger.info('[handleGrafanaEmbeddedDashboard] grafana service NOT found');
      return { applied: false, serviceId: GRAFANA_SERVICE };
    }

    const { tag } = parseImage(service.image ?? '');
    const hasDashboardTag = tag.toLowerCase().includes('dashboard');

    if (!hasDashboardTag) {
      logger.info(
        { image: service.image, tag },
        '[handleGrafanaEmbeddedDashboard] grafana image does not carry the embedded dashboard tag, skipping',
      );
      return { applied: false, serviceId: GRAFANA_SERVICE };
    }

    const { volumes } = service;

    if (!volumes || !Array.isArray(volumes) || volumes.length === 0) {
      logger.info(
        '[handleGrafanaEmbeddedDashboard] grafana already has no volumes (embedded dashboard in use)',
      );
      return { applied: false, serviceId: GRAFANA_SERVICE };
    }

    logger.info(
      { image: service.image, removedVolumes: volumes.length },
      '[handleGrafanaEmbeddedDashboard] embedded dashboard tag detected, removing grafana volumes from compose',
    );

    // Strip ALL grafana volumes so the image's baked-in provisioning is used.
    // Omit `volumes` immutably (no mutation) to satisfy functional/immutable-data.
    const updatedService = removeKey(service, 'volumes');

    const updatedComposeFile = {
      ...composeJson,
      services: {
        ...composeJson.services,
        [GRAFANA_SERVICE]: updatedService,
      },
    };

    await writeComposeFile(updatedComposeFile);

    // Recreate the grafana container with volume removal.
    // `rm -s -v` stops + removes the container and its named/anonymous volumes;
    // the bind mounts are gone from the compose file, so the recreated container
    // won't mount the host ./grafana directory at all.
    await runCmd(rm, GRAFANA_SERVICE, dkrComposeFile, ['-s', '-v']);
    await runCmd(upAll, GRAFANA_SERVICE, dkrComposeFile, [
      '--force-recreate',
      '--no-deps',
    ]);

    logger.info(
      '[handleGrafanaEmbeddedDashboard] grafana container recreated with embedded dashboard',
    );

    return { applied: true, serviceId: GRAFANA_SERVICE };
  };

export default handleGrafanaEmbeddedDashboard;
