import { RouteHandlerMethod } from 'fastify';

import readComposeFile from '../../helpers/readComposeFile/readComposeFile';
import writeComposeFile from '../../helpers/writeComposeFile/writeComposeFile';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const parsedJson = (await readComposeFile()) || {};

    await writeComposeFile(parsedJson, 'compose.generated.yml');

    reply.statusCode = 200;
    reply.send({ success: true, data: parsedJson });
  } catch (error) {
    req.log.error(error);
    process.exit(1);
  }
};

export default handler;
