import { FastifyReply, FastifyRequest } from 'fastify';
import { RestartContainerHandler } from './restartContainer.model';

/**
 * Restart a container
 *
 * This handler will:
 * 1. Get the container by ID
 * 2. Restart the container
 * 3. Return success or error
 */
const handler: RestartContainerHandler = async (req, reply) => {
  try {
    const { id } = req.params;

    // Get the container by ID
    const container = req.server.docker.getContainer(id);

    // Inspect the container to verify it exists
    try {
      await container.inspect();
    } catch (inspectError) {
      req.log.error(`Container not found: ${id}`);
      reply.statusCode = 404;
      reply.send({
        success: false,
        error: `Container with ID ${id} not found`,
      });
      return;
    }

    req.log.info(`Restarting container ${id}`);

    // Restart the container with a 10 second timeout
    await container.restart({ t: 10 });

    req.log.info(`Successfully restarted container ${id}`);

    reply.statusCode = 200;
    reply.send({
      success: true,
      data: [`Container ${id} restarted successfully`],
    });
  } catch (error) {
    req.log.error(
      `Error restarting container ${req.params.id}: ${error instanceof Error ? error.message : String(error)}`,
    );

    reply.statusCode = 500;
    reply.send({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
