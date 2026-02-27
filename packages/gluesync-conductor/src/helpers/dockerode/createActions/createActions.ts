import {
  rm,
  kill,
  pullAll,
  restartAll,
  stop,
  upAll,
  IDockerComposeResult,
} from 'docker-compose';
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
import { enableUpdateMode } from '../../../plugins/apiBlockerAsUpdating';
import restartWindowsDependentServices from '../restartWindowsDependentServices/restartWindowsDependentServices';
import { retryCmd, shouldRetryError } from '../retryHelper/retryHelper';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';
const CONDUCTOR_SERVICE = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
const CORE_HUB_SERVICE = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
const CHRONOS_SERVICE = process.env.CHRONOS_NAME || 'gluesync-chronos';
const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;
const helperImageWindows = process.env.HELPER_IMAGE_BASE || '';

/**
 * Executes a docker-compose command with functional retry logic
 */
export const runCmd: RunCmd = async (
  cmdFn,
  id,
  filename,
  extraOptions,
  maxRetries = 3,
) => {
  const commonOptions: any = {
    cwd: getRootPath(),
    config: filename,
    log: true,
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

  const logger = getLogger();

  const exec = (): Promise<unknown> =>
    cmdFn(options).then((result: Readonly<unknown>) => {
      const typed = result as Readonly<IDockerComposeResult>;
      const msg = typed.out.trim() || typed.err.trim();

      if (typed.exitCode === null || typed.exitCode > 0) {
        if (!isWindows || !shouldRetryError(typed, msg)) {
          throw new Error(msg);
        }
        throw new Error(msg);
      }

      return typed;
    });

  const final = await retryCmd(1, maxRetries, exec, logger, id);

  const finalMessage = final.out.trim() || final.err.trim();

  if (final.exitCode === null || final.exitCode > 0) {
    throw new Error(finalMessage);
  }

  return finalMessage;
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

        // Enable update mode to block incoming requests during conductor restart
        enableUpdateMode();

        // Wrap in setImmediate to send response before conductor dies
        setImmediate(() => {
          autoReboot({
            hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
            serviceName: CONDUCTOR_SERVICE,
            helperImage: isWindows ? helperImageWindows : 'docker:cli',
            log: msg =>
              logger.info({ msg }, '[conductor-updater] self-update log'),
          }).catch(err => {
            logger.error(
              { error: err },
              '[conductor-updater] autoReboot failed',
            );
          });
        });

        return `Conductor ${id} updated and restarted.`;
      }

      await runCmd(upAll, id, filename, ['--remove-orphans']);

      // Special handling for core-hub on Windows only
      // Windows NAT DNS cache requires dependent services to restart for reconnection
      if (id === CORE_HUB_SERVICE && isWindows) {
        return restartWindowsDependentServices(
          docker,
          runCmd,
          filename,
          id,
          CHRONOS_SERVICE,
          CONDUCTOR_SERVICE,
        );
      }

      return `Agent ${id} updated and restarted.`;
    },
  };
};

export default createActions;
