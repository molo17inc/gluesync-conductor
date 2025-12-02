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

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';
const CONDUCTOR_SERVICE = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
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

  const options = isWindows
    ? { ...commonOptions, executablePath: 'docker-compose' } // will spawn `docker-compose instead of docker compose`
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
    start: id => runCmd(upAll, id, filename, ['--no-deps']),
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

        autoReboot({
          hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
          serviceName: CONDUCTOR_SERVICE,
          helperImage: 'docker:cli',
          log: msg =>
            logger.info({ msg }, '[conductor-updater] self-update log'),
        });

        return `Conductor ${id} updated and restarted`;
      }

      await runCmd(upAll, id, filename, ['--remove-orphans']);

      return `Agent ${id} updated and restarted`;
    },
  };
};

export default createActions;
