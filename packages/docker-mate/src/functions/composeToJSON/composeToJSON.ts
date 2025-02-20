import { RouteHandlerMethod } from 'fastify';

import readYmlFile from '../../helpers/readYmlFile/readYmlFile';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const parsedJson = await readYmlFile('debug-container/compose.yml');

    reply.statusCode = 200;
    reply.send({ success: true, data: parsedJson });
  } catch (error) {
    req.log.error(error);
    process.exit(1);
  }
};

export default handler;
