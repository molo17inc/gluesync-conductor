import { stop } from 'docker-compose';

import { StopAgentsHandler } from './stopAgents.model';
import { ComposeFile } from '../../../models/composeFile.model';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';

import getRootPath from '../../../helpers/getRootPath/getRootPath';

const filename = 'compose.agents.yml';

const handler: StopAgentsHandler = async (req, reply) => {
  try {
    const { id } = req.params;
    const parsedJson = await readYmlFile<ComposeFile>(filename);

    if (!parsedJson.services || !parsedJson.services[id]) {
      reply.statusCode = 404;
      reply.send({ success: false, error: `Agent ${id} not found` });
      return;
    }

    const result = await stop({
      cwd: getRootPath(),
      config: filename,
      log: true,
      commandOptions: [id], // Stop only the specified service
    });

    req.log.info(result);

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
    reply.statusCode = 500;
    reply.send({ success: false, error: 'Internal server error' });
  }
};

export default handler;
