import { RouteHandlerMethod } from 'fastify';

import readComposeFile from '../../helpers/readComposeFile/readComposeFile';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const parsedJson = await readComposeFile('compose.yml');

    reply.statusCode = 200;
    reply.send({ success: true, data: parsedJson });
  } catch (error) {
    req.log.error(error);
    process.exit(1);
  }
};

export default handler;
