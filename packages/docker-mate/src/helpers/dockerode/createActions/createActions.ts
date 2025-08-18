import { downAll, upAll } from 'docker-compose';

import { CreateActions } from './createActions.model';

import getRootPath from '../../getRootPath/getRootPath';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'compose.agents.yml';

const createActions: CreateActions = ({
  docker,
  filename = dkrComposeFile,
}) => {
  console.log('getRootPath:', getRootPath());
  return {
    start: async id => {
      const result = await upAll({
        cwd: getRootPath(),
        config: filename,
        log: true,
        commandOptions: ['--no-deps', id], // Start only the specified service
      });

      return result.out.trim() || result.err.trim();
    },
    stop: async id => {
      const container = docker.getContainer(id);

      await container.stop();

      return `Container ${id} stopped`;
    },
    restart: async id => {
      const container = docker.getContainer(id);

      await container.restart();

      return `Container ${id} restarted`;
    },
    // pull: async id => {
    //   const container = docker.getContainer(id);

    //   await container.pull();

    //   return `Container ${id} pulled`;
    // },
    // update: async id => {
    //   const container = docker.getContainer(id);

    //   await container.update();

    //   return `Container ${id} updated`;
    // },
    remove: async id => {
      const container = docker.getContainer(id);

      await container.remove({ force: true });

      return `Container ${id} removed`;
    },
    kill: async id => {
      const result = await downAll({
        cwd: getRootPath(),
        config: filename,
        log: true,
        commandOptions: ['--volumes', '--remove-orphans', id], // remove attached volumes and orphans container attached to the same network
      });

      return result.out.trim() || result.err.trim();
    },
  };
};

export default createActions;
