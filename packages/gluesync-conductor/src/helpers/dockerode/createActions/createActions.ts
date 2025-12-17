import { rm, kill, pullAll, restartAll, stop, upAll } from 'docker-compose';
import { CreateActions, RunCmd } from './createActions.model';
import getRootPath from '../../getRootPath/getRootPath';
import cleanupOrphanNetworkByName from '../cleanupOrphanNetworkByName/cleanupOrphanNetworkByName';
import { readComposeFile } from '../../composeFile/readComposeFile/readComposeFile';
import removeKey from '../../removeKey/removeKey';
import { RawComposeFile } from '../../../models/composeFile.model';
import writeComposeFile from '../../composeFile/writeComposeFile/writeComposeFile';
import { getLogger } from '../../../utils/logger';
import { autoReboot } from '../../autoReboot/autoReboot';
import ensureVolumeDirs from '../../ensureVolumeDirs/ensureVolumeDirs';
import waitForContainerReady from '../../waitForContainerReady/waitForContainerReady';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';
const CONDUCTOR_SERVICE = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
const CORE_HUB_SERVICE = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
const CHRONOS_SERVICE = process.env.CHRONOS_NAME || 'gluesync-chronos';
const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

const runCmd: RunCmd = async (cmdFn, id, filename, extraOptions?) => {
  const commonOptions: any = {
    cwd: getRootPath(),
    config: filename,
    log: true,
    // global options
    composeOptions: [
      '--project-directory',
      getRootPath({ basePath: process.env.BASE_PATH }),
    ],
    commandOptions: [...(extraOptions ?? []), id],
  };

  // On Windows, force standalone docker-compose (spawns `docker-compose ...`)
  const options = isWindows
    ? {
        ...commonOptions,
        executable: {
          standalone: true,
          // optional if not in PATH:
          // executablePath: 'docker-compose',
        },
      }
    : commonOptions;

  const result = await cmdFn(options);

  const message = result.out.trim() || result.err.trim();

  if (result.exitCode === null || result.exitCode > 0) {
    throw new Error(message);
  }

  return message;
};

const createActions: CreateActions = ({
  docker,
  filename = dkrComposeFile,
}) => {
  const logger = getLogger();

  return {
    kill: id => runCmd(kill, id, filename),
    pull: id => runCmd(pullAll, id, filename, ['--include-deps']),
    remove: id => runCmd(rm, id, filename, ['-s', '-v']),
    removeNetwork: id => cleanupOrphanNetworkByName(docker, id),
    restart: id => runCmd(restartAll, id, filename, ['--no-deps']),
    start: async id => {
      if (isWindows) {
        await ensureVolumeDirs(id);
      }
      return runCmd(upAll, id, filename, ['--no-deps']);
    },
    stop: id => runCmd(stop, id, filename),
    undeploy: async (id: string) => {
      await runCmd(rm, id, filename, ['-s', '-v']);

      const composeJson = await readComposeFile({ raw: true });
      if (!composeJson.services || !composeJson.services[id]) {
        return `Agent ${id} not found`;
      }
      const composeFile: RawComposeFile = {
        ...composeJson,
        services: removeKey(composeJson.services, id),
      };
      await writeComposeFile(composeFile);
      return `Agent ${id} undeployed successfully`;
    },
    update: async (id: string) => {
      await runCmd(pullAll, id, filename, ['--include-deps']);

      if (id === CONDUCTOR_SERVICE) {
        logger.info(
          { service: id },
          '[conductor-updater] running self update for conductor',
        );

        const windowsVersion = process.env.WINDOWS_VERSION || '2019';
        const helperImageWindows = `molo17/docker-helper:28.0.0-win-nanoserver-ltsc${windowsVersion}-develop`;

        autoReboot({
          hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
          serviceName: CONDUCTOR_SERVICE,
          helperImage: isWindows ? helperImageWindows : 'docker:cli',
          log: msg =>
            logger.info({ msg }, '[conductor-updater] self-update log'),
        });

        return `Conductor ${id} updated and restarted.`;
      }

      // Special handling for core-hub on Windows only
      // Windows NAT DNS cache requires dependent services to restart for reconnection
      if (id === CORE_HUB_SERVICE && isWindows) {
        logger.info(
          { service: id },
          '[core-hub-updater] updating core-hub (Windows) and restarting dependent services',
        );

        // Update core-hub
        await runCmd(upAll, id, filename, ['--remove-orphans']);

        // Wait for core-hub to be fully ready
        try {
          await waitForContainerReady(docker, CORE_HUB_SERVICE, 10, 1000);
          logger.info(
            { service: CORE_HUB_SERVICE },
            '[core-hub-updater] core-hub is ready',
          );
        } catch (err) {
          logger.warn(
            { service: CORE_HUB_SERVICE, error: err },
            '[core-hub-updater] core-hub readiness check failed, proceeding anyway',
          );
        }

        // Restart chronos and conductor to clear Windows DNS cache and reconnect
        const dependentServices = [CHRONOS_SERVICE, CONDUCTOR_SERVICE];
        const restartResults = await Promise.allSettled(
          dependentServices.map(async serviceId => {
            try {
              await runCmd(restartAll, serviceId, filename, ['--no-deps']);
              logger.info(
                { service: serviceId },
                `[core-hub-updater] restarted ${serviceId} to reconnect to updated core-hub`,
              );
              return `${serviceId} restarted`;
            } catch (err) {
              logger.warn(
                { service: serviceId, error: err },
                `[core-hub-updater] failed to restart ${serviceId}`,
              );
              return `${serviceId} restart failed`;
            }
          }),
        );

        const result = await docker.pruneImages({ force: true });
        const deleted = result.ImagesDeleted?.length || 0;
        const reclaimed = (result.SpaceReclaimed / (1024 * 1024)).toFixed(2);

        const restartSummary = restartResults
          .map(r => (r.status === 'fulfilled' ? r.value : 'failed'))
          .join(', ');

        return deleted > 0
          ? `Core-hub ${id} updated and restarted. Dependent services: ${restartSummary}. Pruned ${deleted} unused images (≈${reclaimed} MB reclaimed).`
          : `Core-hub ${id} updated and restarted. Dependent services: ${restartSummary}. No unused images to prune.`;
      }

      await runCmd(upAll, id, filename, ['--remove-orphans']);

      const result = await docker.pruneImages({ force: true });
      const deleted = result.ImagesDeleted?.length || 0;
      const reclaimed = (result.SpaceReclaimed / (1024 * 1024)).toFixed(2);

      return deleted > 0
        ? `Agent ${id} updated, restarted, and pruned ${deleted} unused images (≈${reclaimed} MB reclaimed).`
        : `Agent ${id} updated and restarted. No unused images were found to prune — system is already clean.`;
    },
  };
};

export default createActions;
