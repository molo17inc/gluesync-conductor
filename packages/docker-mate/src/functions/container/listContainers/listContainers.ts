import parseImageTag from '../../../helpers/parseImageTag/parseImageTag';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';
import { ComposeFile } from '../../../models/composeFile.model';
import {
  ListContainersHandler,
  ContainerListItem,
} from './listContainers.model';

const handler: ListContainersHandler = async (req, reply) => {
  try {
    // Use all: true to show all containers (not just running ones)
    const containerList = await req.server.docker.listContainers({ all: true });

    // Get Docker system information (CPU count and total memory)
    const dockerInfo = await req.server.docker.info();
    const systemInfo = {
      ncpu: dockerInfo.NCPU,
      memTotal: dockerInfo.MemTotal,
    };

    req.log.info(`Successfully listed ${containerList.length} containers`);
    req.log.info(
      `System info - CPUs: ${systemInfo.ncpu}, Memory: ${systemInfo.memTotal} bytes`,
    );

    // Read the compose file to check which containers are persisted
    let composeFile: ComposeFile = { services: {} };
    try {
      composeFile = await readYmlFile<ComposeFile>('compose.agents.yml');
    } catch (ymlError) {
      req.log.warn(
        `Could not read compose file: ${ymlError instanceof Error ? ymlError.message : String(ymlError)}`,
      );
      // Continue without the compose file
    }

    // Get detailed information for each container
    const containers: ContainerListItem[] = [];

    for (const containerInfo of containerList) {
      try {
        const container = req.server.docker.getContainer(containerInfo.Id);
        const details = await container.inspect();

        // Extract the specific fields we need
        const imageString = details.Config?.Image || '';
        const { name, tag } = parseImageTag(imageString);

        // Check if this container is persisted in the compose file
        let persisted = false;
        let versionTagFromLabel = null;

        // Get labels
        const labels = details.Config?.Labels || {};

        // Check for unique ID label
        const uniqueIdLabel = Object.entries(labels).find(
          ([key]) => key === 'com.molo17.conductor.unique_id',
        );

        // Check for version tag label
        const versionTagLabel = Object.entries(labels).find(
          ([key]) => key === 'com.molo17.conductor.versiontag',
        );

        if (versionTagLabel) {
          const [_, versionTag] = versionTagLabel;
          versionTagFromLabel = versionTag;
        }

        if (uniqueIdLabel) {
          const [_, uniqueId] = uniqueIdLabel;
          // Check if any service in the compose file has this unique ID in its labels
          persisted = Object.values(composeFile.services || {}).some(
            service => {
              if (Array.isArray(service.labels)) {
                return service.labels.some(
                  (label: string) =>
                    label === `com.molo17.conductor.unique_id=${uniqueId}`,
                );
              }
              return false;
            },
          );
        }

        const containerDetails: ContainerListItem = {
          id: details.Id,
          name: details.Name ? details.Name.replace(/^\//, '') : '',
          image: imageString,
          tag: tag,
          versionTag: versionTagFromLabel || tag || '', // Use label if available, otherwise use parsed tag, ensure string
          persisted,
          created: details.Created ? details.Created.toString() : '',
          // Extract State fields directly
          running: details.State?.Running || false,
          status: details.State?.Status || '',
          exitCode: details.State?.ExitCode || 0,
          startedAt: details.State?.StartedAt || '',
          finishedAt: details.State?.FinishedAt || '',
          // Extract Config fields directly
          cmd: details.Config?.Cmd || [],
          env: details.Config?.Env || [],
          labels: details.Config?.Labels || {},
          // Extract HostConfig fields directly
          networkMode: details.HostConfig?.NetworkMode || '',
          privileged: details.HostConfig?.Privileged || false,
          // Include other important fields
          ports: containerInfo.Ports || [],
          mounts: details.Mounts || [],
          // Include full HostConfig
          hostConfig: details.HostConfig || {},
        };

        // Add the container details to our array
        containers.push(containerDetails);
      } catch (inspectError) {
        req.log.error(
          `Error inspecting container ${containerInfo.Id}: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`,
        );
        // Return basic info if inspect fails
        const fallbackImageString = containerInfo.Image || '';
        const { name, tag } = parseImageTag(fallbackImageString);

        // For containers where inspect fails, assume they're not persisted
        containers.push({
          id: containerInfo.Id,
          name: containerInfo.Names?.[0]?.replace(/^\//, '') || '',
          image: fallbackImageString,
          tag: tag,
          versionTag: tag || '', // Use parsed tag since we can't access labels
          persisted: false, // Can't check labels if inspect fails
          created: containerInfo.Created
            ? containerInfo.Created.toString()
            : '',
          running: containerInfo.State === 'running',
          status: containerInfo.State || '',
          exitCode: 0,
          startedAt: '',
          finishedAt: '',
          cmd: [],
          env: [],
          labels: containerInfo.Labels || {},
          networkMode: 'default',
          privileged: false,
          ports: containerInfo.Ports || [],
          mounts: [],
          hostConfig: {}, // Empty object for containers where inspect fails
        });
      }
    }

    reply.statusCode = 200;
    reply.send({
      success: true,
      data: containers,
      systemInfo: {
        ncpu: systemInfo.ncpu,
        memTotal: systemInfo.memTotal,
      },
    } as any); // Type assertion to bypass type checking temporarily
  } catch (error) {
    req.log.error(
      `Error listing containers: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );

    try {
      await req.server.docker.ping();
      req.log.info('Docker daemon is responding to ping');
    } catch (pingError) {
      req.log.error(
        `Docker daemon ping failed: ${pingError instanceof Error ? pingError.message : String(pingError)}`,
      );
    }

    reply.statusCode = 500;
    reply.send({
      success: false,
      error: 'Failed to list containers',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
