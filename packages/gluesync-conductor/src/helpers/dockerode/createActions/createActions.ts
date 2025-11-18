import { rm, kill, pullAll, restartAll, stop, upAll } from 'docker-compose';
import { CreateActions, RunCmd } from './createActions.model';
import getRootPath from '../../getRootPath/getRootPath';
import cleanupOrphanNetworkByName from '../cleanupOrphanNetworkByName/cleanupOrphanNetworkByName';
import { readComposeFile } from '../../composeFile/readComposeFile/readComposeFile';
import removeKey from '../../removeKey/removeKey';
import { RawComposeFile } from '../../../models/composeFile.model';
import writeComposeFile from '../../composeFile/writeComposeFile/writeComposeFile';
import { runSelfUpdate } from '../../autoUpdate/autoUpdate';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

const runCmd: RunCmd = async (cmdFn, id, filename, extraOptions?) => {
  const result = await cmdFn({
    cwd: getRootPath(),
    config: filename,
    log: true,
    // global options
    composeOptions: [
      '--project-directory',
      getRootPath({ basePath: process.env.BASE_PATH }),
    ],
    commandOptions: [...(extraOptions ?? []), id],
  });

  const message = result.out.trim() || result.err.trim();

  if (result.exitCode === null || result.exitCode > 0) {
    throw new Error(message);
  }

  return message;
};

const createActions: CreateActions = ({
  docker,
  filename = dkrComposeFile,
}) => ({
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

    console.log('>>>>>>>> eccomiiii ??', id);

    runSelfUpdate({
      hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
      serviceName: 'gluesync-conductor',
      helperImage: 'docker:cli',
      log: function (msg: string): void {
        console.log('>>>>>>>> ERRORE ??', msg);
      },
    });

    return `Agent ${id} updated and restarted`;
  },
});

export default createActions;
