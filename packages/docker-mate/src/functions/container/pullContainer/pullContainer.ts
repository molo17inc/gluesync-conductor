import { PullContainerHandler } from './pullContainer.model';

/**
 * Pull the latest image for a container
 *
 * This handler will:
 * 1. Get the container by ID
 * 2. Get the image information
 * 3. Pull the latest version of the image
 * 4. Return success or error
 */
const handler: PullContainerHandler = async (req, reply) => {
  try {
    const { id } = req.params;

    // Get the container by ID
    const container = req.server.docker.getContainer(id);

    // Inspect the container to get image info
    const containerInfo = await container.inspect();
    const imageName = containerInfo.Config.Image;

    req.log.debug(`Pulling latest image for container ${id} (${imageName})`);

    // Pull the image
    const stream = await req.server.docker.pull(imageName);

    // Process the stream to get progress
    const logs: string[] = [];
    await new Promise<void>((resolve, reject) => {
      req.server.docker.modem.followProgress(
        stream,
        err => {
          if (err) {
            req.log.error(`Error pulling image: ${err.message}`);
            reject(err);
          } else {
            req.log.debug(`Successfully pulled image ${imageName}`);
            resolve();
          }
        },
        event => {
          if (event.progress) {
            logs.push(`${event.id}: ${event.status} ${event.progress}`);
          } else if (event.id) {
            logs.push(`${event.id}: ${event.status}`);
          } else {
            logs.push(event.status);
          }
        },
      );
    });

    reply.statusCode = 200;
    reply.send({
      success: true,
      data: logs,
    });
  } catch (error) {
    req.log.error(
      `Error pulling image for container ${req.params.id}: ${error instanceof Error ? error.message : String(error)}`,
    );

    if (error instanceof Error && error.message.includes('No such container')) {
      reply.statusCode = 404;
      reply.send({
        success: false,
        error: `Container with ID ${req.params.id} not found`,
      });
    } else {
      reply.statusCode = 500;
      reply.send({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

export default handler;
