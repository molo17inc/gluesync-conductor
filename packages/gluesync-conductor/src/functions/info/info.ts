import { RouteHandlerMethod } from 'fastify';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const info = await req.server.docker.info();

    reply.code(200);
    reply.send({ success: true, data: info });
  } catch (error) {
    // A Docker daemon that is restarting or overloaded is not a reason to kill
    // the conductor (and any update it is running): answer 503 and stay up.
    req.log.error({ error }, 'Docker info unavailable');
    reply.code(503);
    reply.send({
      success: false,
      error: 'Docker daemon unavailable',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
