import containerInfoMapper from '../../../helpers/dockerode/containerInfoMapper/containerInfoMapper';
import readComposeFile from '../../../helpers/composeFile/readComposeFile/readComposeFile';

import { ListContainersHandler } from './listContainers.model';

const handler: ListContainersHandler = async (req, reply) => {
  try {
    // Read the compose file to check which containers are persisted
    const composeJson = (await readComposeFile()) || {};

    const dockerComposeServices = Object.keys(composeJson.services || {});

    req.log.debug(
      `dockerComposeServices: ${JSON.stringify(dockerComposeServices)}`,
    );

    // Use all: true to show all containers (not just running ones)
    const containerList = await req.server.docker.listContainers({ all: true });

    req.log.debug(`containerList: ${JSON.stringify(containerList)}`);

    // Get Docker system information (CPU count and total memory)
    const dockerInfo = await req.server.docker.info();
    const systemInfo = {
      ncpu: dockerInfo.NCPU,
      memTotal: dockerInfo.MemTotal,
    };

    req.log.debug(`Successfully listed ${containerList.length} containers`);
    req.log.debug(
      `System info - CPUs: ${systemInfo.ncpu}, Memory: ${systemInfo.memTotal} bytes`,
    );

    // // Get detailed information for each container
    // const getContainerDetails = async (
    //   containerInfo: any,
    // ): Promise<ContainerListItem> => {
    //   try {
    //     const container = req.server.docker.getContainer(containerInfo.Id);
    //     const details = await container.inspect();

    //     // Extract the specific fields we need
    //     const imageString = details.Config?.Image || '';
    //     const { tag } = parseImage(imageString);

    //     // Check if this container is persisted in the compose file
    //     const labels = details.Config?.Labels || {};
    //     const uniqueId = labels['com.molo17.conductor.unique_id'];
    //     const versionTagFromLabel = labels['com.molo17.conductor.versiontag'];

    //     const persisted = uniqueId
    //       ? Object.values(composeJson.services || {}).some(
    //           service =>
    //             Array.isArray(service.labels) &&
    //             service.labels.includes(
    //               `com.molo17.conductor.unique_id=${uniqueId}`,
    //             ),
    //         )
    //       : false;

    //     const containerDetails: ContainerListItem = {
    //       id: details.Id,
    //       name: details.Name ? details.Name.replace(/^\//, '') : '',
    //       image: imageString,
    //       tag: tag,
    //       versionTag: versionTagFromLabel || tag || '', // Use label if available, otherwise use parsed tag, ensure string
    //       persisted,
    //       created: details.Created ? details.Created.toString() : '',
    //       // Extract State fields directly
    //       running: details.State?.Running || false,
    //       status: details.State?.Status || '',
    //       exitCode: details.State?.ExitCode || 0,
    //       startedAt: details.State?.StartedAt || '',
    //       finishedAt: details.State?.FinishedAt || '',
    //       // Extract Config fields directly
    //       cmd: details.Config?.Cmd || [],
    //       env: details.Config?.Env || [],
    //       labels: details.Config?.Labels || {},
    //       // Extract HostConfig fields directly
    //       networkMode: details.HostConfig?.NetworkMode || '',
    //       privileged: details.HostConfig?.Privileged || false,
    //       // Include other important fields
    //       ports: containerInfo.Ports || [],
    //       mounts: details.Mounts || [],
    //       // Include full HostConfig
    //       hostConfig: details.HostConfig || {},
    //     };

    //     return containerDetails;
    //   } catch (inspectError) {
    //     req.log.error(
    //       `Error inspecting container ${containerInfo.Id}: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`,
    //     );
    //     // Return basic info if inspect fails
    //     const fallbackImageString = containerInfo.Image || '';
    //     const { tag } = parseImage(fallbackImageString);

    //     // For containers where inspect fails, assume they're not persisted
    //     return {
    //       id: containerInfo.Id,
    //       name: containerInfo.Names?.[0]?.replace(/^\//, '') || '',
    //       image: fallbackImageString,
    //       tag: tag,
    //       versionTag: tag || '', // Use parsed tag since we can't access labels
    //       persisted: false, // Can't check labels if inspect fails
    //       created: containerInfo.Created
    //         ? containerInfo.Created.toString()
    //         : '',
    //       running: containerInfo.State === 'running',
    //       status: containerInfo.State || '',
    //       exitCode: 0,
    //       startedAt: '',
    //       finishedAt: '',
    //       cmd: [],
    //       env: [],
    //       labels: containerInfo.Labels || {},
    //       networkMode: 'default',
    //       privileged: false,
    //       ports: containerInfo.Ports || [],
    //       mounts: [],
    //       hostConfig: {}, // Empty object for containers where inspect fails
    //     };
    //   }
    // };

    reply.statusCode = 200;
    reply.send({
      success: true,
      data: {
        containers: containerList.map(item => ({
          info: containerInfoMapper(item),
        })),
        systemInfo: {
          ncpu: systemInfo.ncpu,
          memTotal: systemInfo.memTotal,
        },
      },
    });
  } catch (error) {
    req.log.error(
      `Error listing containers: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );

    try {
      await req.server.docker.ping();
      req.log.debug('Docker daemon is responding to ping');
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
