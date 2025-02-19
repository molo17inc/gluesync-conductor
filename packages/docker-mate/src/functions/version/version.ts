import { RouteHandlerMethod } from 'fastify';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const version = await req.server.docker.version();

    reply.statusCode = 200;
    reply.send({ success: true, data: version });
  } catch (error) {
    req.log.error(`Error: ${JSON.stringify(error)}`);
    process.exit(1);
  }
};

export default handler;
