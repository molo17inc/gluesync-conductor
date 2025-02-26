import { upAll } from 'docker-compose';

import { StartAgentsHandler } from './startAgents.model';

import getRootPath from '../../../helpers/getRootPath/getRootPath';

const filename = 'compose.agents.yml';

const handler: StartAgentsHandler = async (req, reply) => {
  try {
    const result = await upAll({
      cwd: getRootPath(),
      config: filename,
      log: true,
    });

    reply.statusCode = 200;
    reply.send({
      success: true,
      data: result.err
        .split('\n')
        .reduce<ReadonlyArray<string>>((acc, line) => {
          const trimmed = line.trim();
          return trimmed ? [...acc, trimmed] : acc;
        }, []),
    });
  } catch (error) {
    req.log.error(error);
    process.exit(1);
  }
};

export default handler;
