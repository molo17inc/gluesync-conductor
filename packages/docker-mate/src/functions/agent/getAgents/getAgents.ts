import type { FastifyReply, FastifyRequest } from 'fastify';
import { GetAgentsHandler } from './getAgents.model';
import parseImageTag from '../../../helpers/parseImageTag/parseImageTag';

/**
 * Get all agents from running Docker containers
 * Filters containers with type=source or type=target in their environment variables
 */
export const getAgents: GetAgentsHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    // Get all containers (running and stopped)
    const containerList = await request.server.docker.listContainers({
      all: true,
    });

    // Get Docker system information (CPU count and total memory)
    const dockerInfo = await request.server.docker.info();
    const systemInfo = {
      ncpu: dockerInfo.NCPU,
      memTotal: dockerInfo.MemTotal,
    };

    request.log.info(
      `Filtering agents from ${containerList.length} containers`,
    );

    // Filter and process containers to find agents
    const agents = [];

    for (const containerInfo of containerList) {
      try {
        const container = request.server.docker.getContainer(containerInfo.Id);
        const details = await container.inspect();

        // Check environment variables for type=source or type=target
        const envVars = details.Config?.Env || [];
        const isAgent = envVars.some((env: string) => {
          return env === 'type=source' || env === 'type=target';
        });

        if (!isAgent) {
          continue; // Skip this container if it's not an agent
        }

        // Extract the type from environment variables
        let type: 'source' | 'target' = 'source'; // Default
        for (const env of envVars) {
          if (typeof env === 'string' && env.startsWith('type=')) {
            const typePart = env.split('=')[1];
            if (typePart === 'source' || typePart === 'target') {
              type = typePart;
              break;
            }
          }
        }

        // Extract the image name and tag
        const imageString = details.Config?.Image || '';
        const { name, tag } = parseImageTag(imageString);

        // Get labels
        const labels = details.Config?.Labels || {};

        // Check for version tag label
        let versionTag = tag || '';
        const versionTagLabel = Object.entries(labels).find(
          ([key]) => key === 'com.molo17.conductor.versiontag',
        );

        if (versionTagLabel) {
          const [_, labelVersionTag] = versionTagLabel;
          versionTag =
            typeof labelVersionTag === 'string' ? labelVersionTag : '';
        }

        agents.push({
          id: containerInfo.Id,
          imageName: name,
          type,
          nickname: details.Name ? details.Name.replace(/^\//, '') : '',
          tag: tag,
          versionTag: versionTag,
          persisted: false, // Not using compose file here
          environment: envVars,
          ports: containerInfo.Ports || [],
          volumes: details.Mounts?.map((mount: any) => mount.Source) || [],
          hostConfig: details.HostConfig || {},
        });
      } catch (containerError) {
        request.log.warn(
          `Error processing container ${containerInfo.Id}: ${containerError instanceof Error ? containerError.message : String(containerError)}`,
        );
        // Continue with next container
      }
    }

    reply.send({
      success: true,
      data: agents,
      systemInfo,
    });
  } catch (error) {
    request.log.error('Error getting agents:', error);
    reply.status(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
