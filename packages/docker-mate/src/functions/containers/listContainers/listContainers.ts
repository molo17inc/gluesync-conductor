import { RouteHandlerMethod } from 'fastify';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const containers = await req.server.docker.listContainers();

    reply.statusCode = 200;
    reply.send({ success: true, data: containers });
  } catch (error) {
    req.log.error(`Error: ${JSON.stringify(error)}`);
    process.exit(1);
  }
};

export default handler;
