import { rm, kill, pullAll, restartAll, stop, upAll } from 'docker-compose';
import { CreateActions, DockerComposeCmd } from './createActions.model';
import getRootPath from '../../getRootPath/getRootPath';
import cleanupOrphanNetworkByName from './cleanOrphanNetwork';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'compose.agents.yml';

const runCmd = async (
  cmdFn: DockerComposeCmd,
  id: string,
  filename: string,
  extraOptions: ReadonlyArray<string> = [],
) => {
  const result = await cmdFn({
    cwd: getRootPath(),
    config: filename,
    log: true,
    commandOptions: [...extraOptions, id],
  });

  return result.out.trim() || result.err.trim();
};

const createActions: CreateActions = ({
  docker,
  filename = dkrComposeFile,
}) => {
  console.log('getRootPath:', getRootPath());

  return {
    start: id => runCmd(upAll, id, filename, ['--no-deps']),
    stop: id => runCmd(stop, id, filename, []),
    restart: id => runCmd(restartAll, id, filename, ['--no-deps']),
    pull: id => runCmd(pullAll, id, filename, ['--include-deps']),
    remove: id => runCmd(rm, id, filename, ['-s', '-v']),
    kill: id => runCmd(kill, id, filename, []),
    removeNetowk: () =>
      cleanupOrphanNetworkByName(docker, 'docker-mate_default'),
    // update: async id => {
    //   const container = docker.getContainer(id);

    //   await container.update();

    //   return `Container ${id} updated`;
    // },
  };
};

export default createActions;
