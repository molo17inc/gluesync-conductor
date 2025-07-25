import { RouteHandlerMethod } from 'fastify';

import readComposeFile from '../../helpers/composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../../helpers/composeFile/writeComposeFile/writeComposeFile';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const composeJson = (await readComposeFile()) || {};

    await writeComposeFile(composeJson, 'compose.generated.yml');

    reply.statusCode = 200;
    reply.send({ success: true, data: composeJson });
  } catch (error) {
    req.log.error(error);
    process.exit(1);
  }
};

export default handler;
