import { rm, kill, pullAll, restartAll, stop, upAll } from 'docker-compose';
import { CreateActions, RunCmd, RunCmdFn } from './createActions.model';
import getRootPath from '../../getRootPath/getRootPath';
import cleanupOrphanNetworkByName from '../cleanupOrphanNetworkByName/cleanupOrphanNetworkByName';
import { readComposeFile } from '../../composeFile/readComposeFile/readComposeFile';
import removeKey from '../../removeKey/removeKey';
import { RawComposeFile } from '../../../models/composeFile.model';
import writeComposeFile from '../../composeFile/writeComposeFile/writeComposeFile';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'compose.agents.yml';

const runCmd: RunCmd = async (
  cmdFn: RunCmdFn,
  id: string,
  filename: string,
  extraOptions?: ReadonlyArray<string>,
) => {
  const result = await cmdFn({
    cwd: getRootPath(),
    config: filename,
    log: true,
    commandOptions: [...(extraOptions ?? []), id],
  });

  const message = result.out.trim() || result.err.trim();

  if (result.exitCode === null || result.exitCode > 0) {
    throw new Error(message);
  }

  console.log(`Error: ${JSON.stringify(result)}`);

  return result.out.trim() || result.err.trim();
};

const cleanFromFile = async (id: string) => {
  try {
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
  } catch (error) {
    return `Error: ${JSON.stringify(error)}`;
  }
};

const createActions: CreateActions = ({
  docker,
  filename = dkrComposeFile,
}) => ({
  kill: id => runCmd(kill, id, filename),
  pull: id => runCmd(pullAll, id, filename, ['--include-deps']),
  remove: id => runCmd(rm, id, filename, ['-s', '-v']), // remove stopped container and remove also attached volumes
  removeNetwork: id => cleanupOrphanNetworkByName(docker, id),
  restart: id => runCmd(restartAll, id, filename, ['--no-deps']),
  start: id => runCmd(upAll, id, filename, ['--no-deps']),
  stop: id => runCmd(stop, id, filename),
  undeploy: async (id: string) => {
    try {
      // Step 1: Remove the container
      await runCmd(rm, id, filename, ['-s', '-v']);

      // Step 2: Remove the agent from file
      return await cleanFromFile(id);
    } catch (error) {
      return `Error: ${JSON.stringify(error)}`;
    }
  },
  // update: async id => {
  //   const container = docker.getContainer(id);

  //   await container.update();

  //   return \`Container ${id} updated\`;
  // },
});

export default createActions;
