import { RawComposeService } from '../../models/composeFile.model';
import { getLogger } from '../../utils/logger';
import { SplitGrafanaProvisioningMount } from './splitGrafanaProvisioningMount.model';

/**
 * Patterns for the old full-provisioning mount that shadows the image's
 * baked-in dashboards. We match the container-side path, ignoring the
 * host-side path (which may vary) and any `:ro` / `:rw` mode suffix.
 *
 * Linux:   ./grafana:/etc/grafana/provisioning
 * Windows: ./grafana:C:\grafana\conf\provisioning
 */
const LINUX_PROVISIONING_PATH = '/etc/grafana/provisioning';
const WINDOWS_PROVISIONING_PATH = 'C:\\grafana\\conf\\provisioning';

const LINUX_DATASOURCES_MOUNT =
  './grafana/datasources:/etc/grafana/provisioning/datasources';
const WINDOWS_DATASOURCES_MOUNT =
  './grafana/datasources:C:\\grafana\\conf\\provisioning\\datasources';

/**
 * Extract the container-side path from a bind-mount string.
 * Handles both `host:container` and `host:container:mode` formats.
 */
const getContainerPath = (volume: string): string => {
  // Windows paths contain colons (e.g. C:\...), so we split from the right.
  // A bind mount has 2 or 3 colon-separated parts:
  //   host:container          (Linux)
  //   host:container:mode     (Linux)
  //   host:C:\path            (Windows)
  //   host:C:\path:mode       (Windows)
  const parts = volume.split(':');
  if (parts.length < 2) {
    return '';
  }

  // If the last part is 'ro' or 'rw', it's a mode suffix — drop it
  const lastPart = parts[parts.length - 1].toLowerCase();
  const hasMode = lastPart === 'ro' || lastPart === 'rw';

  // Container path is everything between the first colon and the optional mode
  // For Windows: host:C:\grafana\conf\provisioning → parts = [host, C, \grafana\conf\provisioning]
  // We need to rejoin the container path parts
  const containerParts = hasMode ? parts.slice(1, -1) : parts.slice(1);

  return containerParts.join(':');
};

/**
 * Check whether a volume string is the old full-provisioning mount.
 */
const isFullProvisioningMount = (volume: string): boolean => {
  const containerPath = getContainerPath(volume);
  return (
    containerPath === LINUX_PROVISIONING_PATH ||
    containerPath === WINDOWS_PROVISIONING_PATH
  );
};

/**
 * Check whether a volume string is already the split datasources mount.
 */
const isDatasourcesMount = (volume: string): boolean => {
  const containerPath = getContainerPath(volume);
  return (
    containerPath === `${LINUX_PROVISIONING_PATH}/datasources` ||
    containerPath === `${WINDOWS_PROVISIONING_PATH}\\datasources`
  );
};

const splitGrafanaProvisioningMount: SplitGrafanaProvisioningMount =
  services => {
    const logger = getLogger();

    const grafanaServiceName = 'grafana';
    const service = services[grafanaServiceName];

    if (!service) {
      logger.info('[splitGrafanaProvisioningMount] grafana service NOT found');
      return { services, updatedIds: [] };
    }

    const { volumes } = service;

    if (!volumes || !Array.isArray(volumes) || volumes.length === 0) {
      logger.info(
        '[splitGrafanaProvisioningMount] grafana service has no volumes',
      );
      return { services, updatedIds: [] };
    }

    // Check if already split
    const hasDatasourcesMount = volumes.some(
      (v: string) => typeof v === 'string' && isDatasourcesMount(v),
    );

    if (hasDatasourcesMount) {
      logger.debug(
        '[splitGrafanaProvisioningMount] grafana already uses split mount',
      );
      return { services, updatedIds: [] };
    }

    // Find the old full-provisioning mount
    const fullMountIndex = volumes.findIndex(
      (v: string) => typeof v === 'string' && isFullProvisioningMount(v),
    );

    if (fullMountIndex === -1) {
      logger.debug(
        '[splitGrafanaProvisioningMount] no full-provisioning mount found',
      );
      return { services, updatedIds: [] };
    }

    const fullMount = volumes[fullMountIndex] as string;
    const containerPath = getContainerPath(fullMount);

    // Determine the replacement based on the platform (Linux vs Windows path)
    const isWindows = containerPath === WINDOWS_PROVISIONING_PATH;
    const replacement = isWindows
      ? WINDOWS_DATASOURCES_MOUNT
      : LINUX_DATASOURCES_MOUNT;

    const updatedVolumes = [
      ...volumes.slice(0, fullMountIndex),
      replacement,
      ...volumes.slice(fullMountIndex + 1),
    ];

    const updatedService: RawComposeService = {
      ...service,
      volumes: updatedVolumes,
    };

    logger.info(
      { fullMount, replacement },
      '[splitGrafanaProvisioningMount] split grafana provisioning mount',
    );

    return {
      services: {
        ...services,
        [grafanaServiceName]: updatedService,
      },
      updatedIds: [grafanaServiceName],
    };
  };

export default splitGrafanaProvisioningMount;
