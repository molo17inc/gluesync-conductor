import {
  rm,
  kill,
  pullAll,
  restartAll,
  stop,
  upAll,
  IDockerComposeResult,
} from 'docker-compose';
import { ContainerAction, CreateActions, RunCmd } from './createActions.model';
import { ContainerActions } from '../../../models/conductor.model';
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
import { retryCmd } from '../retryHelper/retryHelper';
import verifyServiceStable from '../../verifyServiceStable/verifyServiceStable';
import { getDecidedOrchestrator } from '../../orchestrator/getOrchestrator/getOrchestrator';
import createSwarmActions from '../../swarm/createSwarmActions/createSwarmActions';
import waitForDockerOutage, {
  dockerWaitMs,
} from '../waitForDockerOutage/waitForDockerOutage';
import { PREFLIGHT_MAX_MS } from '../waitForDockerPreflight/waitForDockerPreflight';
import { getDocker } from '../../../utils/docker/getDocker';
import {
  composeChildEnv,
  composeEnvFileOptions,
} from '../../containerRuntime/composeEnv';
import { HELPER_IMAGE_CLI } from '../../containerRuntime/helperImages';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';
const CONDUCTOR_SERVICE = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
const CORE_HUB_SERVICE = process.env.CORE_HUB_NAME || 'gluesync-core-hub';
const CHRONOS_SERVICE = process.env.CHRONOS_NAME || 'gluesync-chronos';
const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;
const helperImageWindows = process.env.HELPER_IMAGE_BASE || '';

// docker-compose (the npm package) rejects with a plain { exitCode, err, out }
// object, not an Error: nothing downstream (the retry check, the logs) could
// read a message from it. The compose output becomes the message, so a Docker
// connection error is recognised as one.
export const toComposeError = (failure: unknown): Error => {
  if (failure instanceof Error) {
    return failure;
  }
  const { err, out, exitCode } = (failure ?? {}) as Partial<
    Record<'err' | 'out' | 'exitCode', unknown>
  >;
  const message = [err, out]
    .map(text => (typeof text === 'string' ? text.trim() : ''))
    .find(text => text !== '');
  return Object.assign(new Error(message ?? 'docker-compose failed'), {
    exitCode: typeof exitCode === 'number' ? exitCode : null,
  });
};

const failOnExitCode = (
  result: Readonly<IDockerComposeResult>,
): IDockerComposeResult => {
  if (result.exitCode === null || result.exitCode > 0) {
    throw toComposeError(result);
  }
  return result;
};

/**
 * Executes a docker-compose command with functional retry logic. A Docker API
 * that drops (the compose CLI says "error during connect", "connection refused",
 * ...) is waited for and the command tried again; any other failure (a bad
 * image, a port conflict) is final.
 */
export const runCmd: RunCmd = async (
  cmdFn,
  id,
  filename,
  extraOptions,
  maxRetries = 3,
) => {
  // The project directory is a HOST path (relative binds resolve against it),
  // which usually does not exist in here: the kit `.env` is given by path, and
  // the socket this Conductor runs on is added when no `.env` says it (a
  // recreate of the Conductor or of the proxy must keep its socket mount).
  const env = await composeChildEnv(getDocker());
  const commonOptions: any = {
    cwd: getRootPath(),
    config: filename,
    log: true,
    composeOptions: [
      '--project-directory',
      getRootPath({ basePath: process.env.BASE_PATH }),
      ...composeEnvFileOptions(),
    ],
    commandOptions: [...(extraOptions ?? []), id],
    ...(env && { env }),
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

  const exec = (): Promise<unknown> =>
    cmdFn(options).then(failOnExitCode, (error_: unknown) => {
      throw toComposeError(error_);
    });

  const final = await retryCmd(1, maxRetries, exec, getLogger(), id, () =>
    waitForDockerOutage(getDocker()),
  );

  return final.out.trim() || final.err.trim();
};

const composeActions = ({
  docker,
  filename = dkrComposeFile,
  previousImages = {},
}: Parameters<CreateActions>[0]): Record<ContainerActions, ContainerAction> => {
  const logger = getLogger();

  return {
    kill: id => runCmd(kill, id, filename),
    pull: id => runCmd(pullAll, id, filename, ['--include-deps']),
    remove: id => runCmd(rm, id, filename, ['-s', '-v']),
    removeNetwork: id => cleanupOrphanNetworkByName(docker, id),
    restart: id => runCmd(restartAll, id, filename, ['--no-deps']),
    start: async id => {
      await ensureVolumeDirs(id);
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
      // Nothing is touched while the Docker API is down: this fails early, with
      // an error that says so, instead of halfway through the update.
      await waitForDockerOutage(
        docker,
        Math.min(dockerWaitMs(), PREFLIGHT_MAX_MS),
      );

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
            helperImage: isWindows ? helperImageWindows : HELPER_IMAGE_CLI,
            rollbackImage: previousImages[CONDUCTOR_SERVICE],
            log: msg =>
              logger.info({ msg }, '[conductor-updater] self-update log'),
          }).catch(error => {
            logger.error(
              {
                error,
              },
              '[conductor-updater] autoReboot failed',
            );
          });
        });

        return `Conductor ${id} updated and restarted.`;
      }

      await runCmd(upAll, id, filename, ['--remove-orphans']);

      // Special handling for core-hub on Windows only
      // Windows NAT DNS cache requires dependent services to restart for reconnection
      const restarted =
        id === CORE_HUB_SERVICE && isWindows
          ? await restartWindowsDependentServices(
              docker,
              runCmd,
              filename,
              id,
              CHRONOS_SERVICE,
              CONDUCTOR_SERVICE,
            )
          : `Agent ${id} updated and restarted.`;

      // "up" succeeds even when the new image crashes right away: only report
      // success once the container has stayed up.
      await verifyServiceStable(docker, id);

      return restarted;
    },
  };
};

const NOT_DECIDED =
  'Cannot tell whether Gluesync runs on Docker Compose or Docker Swarm: the Docker daemon is not answering';

/**
 * The actions of whichever orchestrator runs this Conductor (compose, or the
 * swarm stack of docs/swarm-mode.md). The mode is looked up when an action
 * runs, and an action never falls back to compose when it is not known: that
 * would recreate containers by hand inside a swarm.
 */
const createActions: CreateActions = options => {
  const compose = composeActions(options);
  const { docker, filename = dkrComposeFile } = options;

  const forMode =
    (action: Exclude<ContainerActions, 'removeNetwork'>) =>
    async (id: string): Promise<string> => {
      const orchestrator = await getDecidedOrchestrator(docker);

      if (!orchestrator) {
        throw new Error(NOT_DECIDED);
      }

      return orchestrator.mode === 'swarm'
        ? createSwarmActions({ docker, orchestrator, filename })[action](id)
        : compose[action](id);
    };

  return {
    kill: forMode('kill'),
    pull: forMode('pull'),
    remove: forMode('remove'),
    removeNetwork: compose.removeNetwork,
    restart: forMode('restart'),
    start: forMode('start'),
    stop: forMode('stop'),
    undeploy: forMode('undeploy'),
    update: forMode('update'),
  };
};

export default createActions;
