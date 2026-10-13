import { RouteHandlerMethod } from 'fastify';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const version = await req.server.docker.version();

    reply.code(200);
    reply.send({ success: true, data: version });
  } catch (error) {
    // A Docker daemon that is restarting or overloaded is not a reason to kill
    // the conductor (and any update it is running): answer 503 and stay up.
    req.log.error({ error }, 'Docker version unavailable');
    reply.code(503);
    reply.send({
      success: false,
      error: 'Docker daemon unavailable',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
