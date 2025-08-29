import { DoContainersActionHandler } from './doContainersAction.model';
import createActions from '../../../helpers/dockerode/createActions/createActions';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import canUpdateContainers from '../../../helpers/canUpdateContainers/canUpdateContainers';
import editUpdateImagesInComposeFile from '../../../helpers/editUpdatedImagesInComposeFile/editUpdateImagesInComposeFile';

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

    if (containerAction === 'update') {
      // added core hub id in case of update because all agent and core hub need to have the same versionTag
      const containerIdsUpdate = [
        process.env.CORE_HUB_NAME || 'gluesync-core-hub',
        ...containerIds,
      ];
      const composeJson = await readComposeFile({ raw: true });

      const canUpdateContainersResult = await canUpdateContainers(
        containerIdsUpdate,
        composeJson,
      );

      if (!canUpdateContainersResult.success) {
        reply.code(500);
        throw new Error(canUpdateContainersResult.message);
      }

      await editUpdateImagesInComposeFile(
        containerIdsUpdate,
        composeJson,
        String(canUpdateContainersResult.data),
      );

      // Run update for all including core hub concurrently
      const results = await Promise.allSettled(containerIdsUpdate.map(action));

      req.log.debug(
        `Container action ${containerAction}: ${JSON.stringify(results)}`,
      );

      const resultPrune = await req.server.docker.pruneImages({ force: true });

      const pruneResultText =
        resultPrune.ImagesDeleted && resultPrune.ImagesDeleted.length
          ? `Pruned ${resultPrune.ImagesDeleted.length} images, and reclaimed ${(resultPrune.SpaceReclaimed / (1024 * 1024)).toFixed(2)} MB disk space successfully`
          : undefined;

      reply.code(200);
      reply.send({
        success: true,
        data: {
          ...(pruneResultText && { pruneResult: pruneResultText }),
          containers: results.map((result, index) => ({
            id: containerIdsUpdate[index],
            status: result.status === 'fulfilled' ? 'OK' : 'ERROR',
            message:
              result.status === 'fulfilled'
                ? result.value
                : result?.reason?.err,
          })),
        },
      });
    } else {
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
              result.status === 'fulfilled'
                ? result.value
                : result?.reason?.err,
          })),
        },
      });
    }
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
