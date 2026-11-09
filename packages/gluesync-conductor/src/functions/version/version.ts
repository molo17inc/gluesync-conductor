import { RouteHandlerMethod } from 'fastify';
import { getContainerEngine } from '../../helpers/containerRuntime/containerEngine';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const version = await req.server.docker.version();
    // Additive: which engine this is (Docker or Podman) and whether it is rootless
    const containerEngine = await getContainerEngine(req.server.docker);

    reply.code(200);
    reply.send({
      success: true,
      data: containerEngine ? { ...version, containerEngine } : version,
    });
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
