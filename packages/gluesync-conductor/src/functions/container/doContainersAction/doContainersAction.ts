import { DoContainersActionHandler } from './doContainersAction.model';

import createActions from '../../../helpers/dockerode/createActions/createActions';

const handler: DoContainersActionHandler = async (req, reply) => {
  try {
    const containerAction = req.body.action;
    const containerIds = req.body.ids;

    const actions = createActions({ docker: req.server.docker });
    const action = actions[containerAction];
    if (!action) {
      reply.code(400);
      throw new Error(`Unknown action: ${containerAction}`);
    }

    const results = await Promise.allSettled(containerIds.map(action));

    req.log.debug(
      `Container action ${containerAction}: ${JSON.stringify(results)}`,
    );

    reply.code(200);
    reply.send({
      success: true,
      data: {
        containers: results.map((result, index) => ({
          id: containerIds[index],
          status: result.status === 'fulfilled' ? 'OK' : 'ERROR',
          message:
            result.status === 'fulfilled' ? result.value : result?.reason?.err,
        })),
      },
    });
  } catch (error) {
    req.log.error(
      `Error do containers action: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );

    try {
      await req.server.docker.ping();
      req.log.debug('Docker daemon is responding to ping');
    } catch (pingError) {
      req.log.error(
        `Docker daemon ping failed: ${pingError instanceof Error ? pingError.message : String(pingError)}`,
      );
    }

    reply.code(500);
    reply.send({
      success: false,
      error: 'Failed to do containers action',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
