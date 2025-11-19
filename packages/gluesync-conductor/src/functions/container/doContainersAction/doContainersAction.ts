import { DoContainersActionHandler } from './doContainersAction.model';
import createActions from '../../../helpers/dockerode/createActions/createActions';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import canUpdateContainers from '../../../helpers/canUpdateContainers/canUpdateContainers';
import editUpdateImagesInComposeFile from '../../../helpers/editUpdatedImagesInComposeFile/editUpdateImagesInComposeFile';
import fetchAllServicesInCompose from '../../../helpers/fetchAllServicesInCompose/fetchAllServicesInCompose';
import { LabelPrefix } from '../../../models/composeFile.model';
import checkConductorUpdate from '../../../helpers/checkConductorUpdate/checkConductorUpdate';

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

      // ----- conductor-only branch -----
      if (conductorInfo?.needsUpdate) {
        const { ids, availableVersion } = conductorInfo;

        if (!availableVersion) {
          reply.code(500);
          throw new Error('No available version for conductor');
        }

        const effectiveIds = ids;

        const conductorVersions = {
          agentVersion: null,
          modules: [
            {
              id: ids[0],
              version: availableVersion,
            },
          ],
        };

        await editUpdateImagesInComposeFile(
          effectiveIds,
          composeJson,
          conductorVersions,
        );

        const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';

        const orderedIds: readonly string[] = effectiveIds.includes(coreHubName)
          ? [coreHubName, ...effectiveIds.filter(id => id !== coreHubName)]
          : effectiveIds;

        const results = await Promise.allSettled(orderedIds.map(action));

        req.log.debug(
          `Container action ${containerAction} (conductor-only): ${JSON.stringify(
            results,
          )}`,
        );

        const resultPrune = await req.server.docker.pruneImages({
          force: true,
        });

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
              id: orderedIds[index],
              status: result.status === 'fulfilled' ? 'OK' : 'ERROR',
              message:
                result.status === 'fulfilled'
                  ? result.value
                  : result?.reason?.err,
            })),
          },
        });

        return;
      }

      // ----- normal bulk-update branch -----
      const initialEffectiveIds: ReadonlyArray<string> =
        requestIds.length === 0
          ? fetchAllServicesInCompose(composeJson, true)
              .filter(id => id !== 'gluesync-conductor')
              .filter(id => {
                const service = composeJson.services?.[id];
                if (!service) return false;

                const serviceTypeArray: ReadonlyArray<string> = Array.isArray(
                  service?.labels,
                )
                  ? service.labels
                  : Object.entries(service?.labels || {}).map(
                      ([k, v]) => `${k}=${v}`,
                    );

                return serviceTypeArray.some(label =>
                  label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`),
                );
              })
          : requestIds;

      const canUpdateContainersResult = await canUpdateContainers(
        initialEffectiveIds,
        composeJson,
        releaseChannel,
      );

      if (
        !canUpdateContainersResult.success ||
        !canUpdateContainersResult.data
      ) {
        reply.code(500);
        throw new Error(canUpdateContainersResult.message);
      }

      const invalidModuleIds = canUpdateContainersResult.data.modules
        .filter(m => m.version === null)
        .map(m => m.id);

      const effectiveIds = initialEffectiveIds.filter(
        id => !invalidModuleIds.includes(id),
      );

      await editUpdateImagesInComposeFile(
        effectiveIds,
        composeJson,
        canUpdateContainersResult.data,
      );

      const coreHubName = process.env.CORE_HUB_NAME || 'gluesync-core-hub';

      const orderedIds: readonly string[] = effectiveIds.includes(coreHubName)
        ? [coreHubName, ...effectiveIds.filter(id => id !== coreHubName)]
        : effectiveIds;

      const results = await Promise.allSettled(orderedIds.map(action));

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
            id: orderedIds[index],
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
