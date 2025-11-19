import { DoContainersActionHandler } from './doContainersAction.model';
import createActions from '../../../helpers/dockerode/createActions/createActions';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import checkConductorUpdate from '../../../helpers/checkConductorUpdate/checkConductorUpdate';
import updateConductorOnly from './handleUpdate/updateConductorOnly';
import updateNormalBulk from './handleUpdate/updateNormalBulk';

const handler: DoContainersActionHandler = async (req, reply) => {
  try {
    const containerAction = req.body.action;
    const requestIds: readonly string[] = req.body.ids || [];
    const releaseChannel = req.body.releaseChannel || 'ga';

    const actions = createActions({ docker: req.server.docker });
    const action = actions[containerAction];

    if (!action) {
      reply.code(400);
      throw new Error(`Unknown action: ${containerAction}`);
    }

    if (containerAction === 'update') {
      const composeJson = await readComposeFile({ raw: true });
      req.log.debug(
        `Checking for conductor update, ids length=${requestIds.length}`,
      );

      const conductorInfo = await checkConductorUpdate({
        composeJson,
        releaseChannel,
      });

      const branchResult =
        conductorInfo?.needsUpdate && requestIds.length === 0
          ? await updateConductorOnly(action, conductorInfo, composeJson)
          : await updateNormalBulk(
              action,
              composeJson,
              requestIds,
              releaseChannel,
            );

      const ids =
        'id' in branchResult ? [branchResult.id] : branchResult.orderedIds;
      const { results } = branchResult;

      req.log.debug(
        `Container action ${containerAction}: ${JSON.stringify(results)}`,
      );

      const resultPrune = await req.server.docker.pruneImages({ force: true });
      const pruneResultText =
        resultPrune.ImagesDeleted && resultPrune.ImagesDeleted.length
          ? `Pruned ${resultPrune.ImagesDeleted.length} images, and reclaimed ${(
              resultPrune.SpaceReclaimed /
              (1024 * 1024)
            ).toFixed(2)} MB disk space successfully`
          : undefined;

      reply.code(200);
      reply.send({
        success: true,
        data: {
          ...(pruneResultText && { pruneResult: pruneResultText }),
          containers: results.map((result, index) => ({
            id: ids[index],
            status: result.status === 'fulfilled' ? 'OK' : 'ERROR',
            message:
              result.status === 'fulfilled'
                ? result.value
                : result?.reason?.err,
          })),
        },
      });
    } else {
      const results = await Promise.allSettled(requestIds.map(action));

      req.log.debug(
        `Container action ${containerAction}: ${JSON.stringify(results)}`,
      );

      reply.code(200);
      reply.send({
        success: true,
        data: {
          containers: results.map((result, index) => ({
            id: requestIds[index],
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
      `Error do containers action: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`,
    );

    try {
      await req.server.docker.ping();
      req.log.debug('Docker daemon is responding to ping');
    } catch (pingError) {
      req.log.error(
        `Docker daemon ping failed: ${
          pingError instanceof Error ? pingError.message : String(pingError)
        }`,
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
