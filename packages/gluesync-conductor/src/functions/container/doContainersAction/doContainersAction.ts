import { DoContainersActionHandler } from './doContainersAction.model';
import createActions from '../../../helpers/dockerode/createActions/createActions';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import { RawComposeFile } from '../../../models/composeFile.model';
import extractImageInfo from '../../../helpers/extractImageInfo/extractImageInfo';
import fetchAgentInfo from '../../../helpers/agentInfo/agentInfo';
import { AgentInfoResponse } from '../../../helpers/agentInfo/agentInfo.model';

const canUpdateContainers = async (
  containerIds: ReadonlyArray<string>,
  composeJson: RawComposeFile,
): Promise<
  | false
  | string
  | { errors: (string | null)[]; message: string }
  | `Agent ${string} not found`
> => {
  const agentInfoPromises = containerIds.map(async id => {
    const service = composeJson.services?.[id];
    if (!service) {
      throw new Error(`Agent ${id} not found`);
    }
    const cleanedName = extractImageInfo(service.image).name;
    return fetchAgentInfo(cleanedName);
  });

  const settledResults = await Promise.allSettled(agentInfoPromises);

  // Collect error messages or null for each container
  const errors = settledResults.map(result =>
    result.status === 'rejected'
      ? result.reason?.message || String(result.reason)
      : null,
  );

  // Return immediately if any "Agent not found" error exists
  const notFoundError = errors.find(e => e?.startsWith('Agent '));
  if (notFoundError) {
    return notFoundError as `Agent ${string} not found`;
  }

  // Extract fulfilled results with agent info
  const fulfilledAgentInfos = settledResults
    .filter(
      (r): r is PromiseFulfilledResult<AgentInfoResponse> =>
        r.status === 'fulfilled',
    )
    .map(r => r.value);

  // Extract latestVersionGA, filtering out falsy values
  const latestVersions = fulfilledAgentInfos
    .map(agentInfo => agentInfo.AvailableAgents?.latestVersionGA)
    .filter((v): v is string => Boolean(v));

  // Check if all latestVersionGA strings are equal (and non-empty)
  const allEqual =
    latestVersions.length > 0 &&
    latestVersions.every(v => v === latestVersions[0]);

  // If versions mismatched, return errors info otherwise the common version string
  if (!allEqual) {
    const errorMessages = errors.filter(Boolean).join('\n');

    return {
      errors,
      message: errorMessages,
    };
  }

  return latestVersions[0];
};

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
      const composeJson = await readComposeFile({ raw: true });

      const updateResult = await canUpdateContainers(containerIds, composeJson);

      if (
        typeof updateResult === 'object' &&
        'errors' in updateResult &&
        'message' in updateResult
      ) {
        reply.code(400);
        reply.send({
          success: false,
          error: '',
          details: updateResult.message,
        });

        return; // Exit after sending error response
      }
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
