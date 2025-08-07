import { GetAgentsHandler } from './getAgents.model';
import parseImage from '../../../helpers/parseImage/parseImage';
import getSystemInfo from '../../../helpers/dockerode/getSystemInfo/getSystemInfo';

/**
 * Get all agents from running Docker containers
 * Filters containers with type=source or type=target in their environment variables
 */
export const getAgents: GetAgentsHandler = async (req, reply) => {
  try {
    // Get all containers (running and stopped)
    const containerList = await req.server.docker.listContainers({
      all: true,
    });

    // Get Docker system information (CPU count and total memory)
    const systemInfo = await getSystemInfo(req.server.docker, req.log);

    req.log.info(`Filtering agents from ${containerList.length} containers`);

    // Filter and process containers to find agents
    const agents = [];

    // eslint-disable-next-line no-restricted-syntax, functional/no-loop-statements
    for (const containerInfo of containerList) {
      try {
        const container = req.server.docker.getContainer(containerInfo.Id);
        // eslint-disable-next-line no-await-in-loop
        const details = await container.inspect();

        // Check environment variables for type=source or type=target
        const envVars = details.Config?.Env || [];
        const isAgent = envVars.some(
          (env: string) => env === 'type=source' || env === 'type=target',
        );

        if (!isAgent) {
          // eslint-disable-next-line no-continue
          continue; // Skip this container if it's not an agent
        }

        // Extract the type from environment variables
        // eslint-disable-next-line functional/no-let
        let type: 'source' | 'target' = 'source'; // Default
        // eslint-disable-next-line no-restricted-syntax, functional/no-loop-statements
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
        const { imageName, tag } = parseImage(imageString);

        // Get labels
        const labels = details.Config?.Labels || {};

        // Check for version tag label
        // eslint-disable-next-line functional/no-let
        let versionTag = tag || '';
        const versionTagLabel = Object.entries(labels).find(
          ([key]) => key === 'com.molo17.conductor.versiontag',
        );

        if (versionTagLabel) {
          const [, labelVersionTag] = versionTagLabel;
          versionTag =
            typeof labelVersionTag === 'string' ? labelVersionTag : '';
        }

        // eslint-disable-next-line functional/immutable-data
        agents.push({
          id: containerInfo.Id,
          imageName,
          type,
          nickname: details.Name ? details.Name.replace(/^\//, '') : '',
          tag,
          versionTag,
          persisted: false, // Not using compose file here
          environment: envVars,
          ports: containerInfo.Ports || [],
          volumes: details.Mounts?.map((mount: any) => mount.Source) || [],
          hostConfig: details.HostConfig || {},
        });
      } catch (containerError) {
        req.log.warn(
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
    req.log.error('Error getting agents:', error);
    reply.status(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
