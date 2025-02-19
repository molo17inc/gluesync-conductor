import { RouteHandlerMethod } from 'fastify';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const info = await req.server.docker.info();

    reply.statusCode = 200;
    reply.send({ success: true, data: info });
  } catch (error) {
    req.log.error(`Error: ${JSON.stringify(error)}`);
    process.exit(1);
  }
};

export default handler;
