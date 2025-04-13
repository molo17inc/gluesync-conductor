import { RouteHandlerMethod } from 'fastify';
import parseImageTag from '../../../helpers/parseImageTag/parseImageTag';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    // Use all: true to show all containers (not just running ones)
    const containerList = await req.server.docker.listContainers({ all: true });
    
    req.log.info(`Successfully listed ${containerList.length} containers`);

    // Get detailed information for each container
    const containers = [];
    
    for (const containerInfo of containerList) {
      try {
        const container = req.server.docker.getContainer(containerInfo.Id);
        const details = await container.inspect();
        
        // Extract the specific fields we need
        const imageString = details.Config?.Image || '';
        const { name, tag } = parseImageTag(imageString);
        
        const containerDetails = {
          id: details.Id,
          name: details.Name ? details.Name.replace(/^\//, '') : '',
          image: imageString,
          tag: tag,
          created: details.Created || '',
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
          mounts: details.Mounts || []
        };
        
        // Add the container details to our array
        containers.push(containerDetails);
      } catch (inspectError) {
        req.log.error(`Error inspecting container ${containerInfo.Id}: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`);
        // Return basic info if inspect fails
        const fallbackImageString = containerInfo.Image || '';
        const { name, tag } = parseImageTag(fallbackImageString);
        
        containers.push({
          id: containerInfo.Id,
          name: containerInfo.Names?.[0]?.replace(/^\//, '') || '',
          image: fallbackImageString,
          tag: tag,
          created: containerInfo.Created || '',
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
          mounts: []
        });
      }
    }

    reply.statusCode = 200;
    reply.send({ success: true, data: containers });
  } catch (error) {
    req.log.error(`Error listing containers: ${error instanceof Error ? error.message : JSON.stringify(error)}`);

    try {
      await req.server.docker.ping();
      req.log.info('Docker daemon is responding to ping');
    } catch (pingError) {
      req.log.error(`Docker daemon ping failed: ${pingError instanceof Error ? pingError.message : String(pingError)}`);
    }

    reply.statusCode = 500;
    reply.send({ success: false, error: 'Failed to list containers', details: error instanceof Error ? error.message : String(error) });
  }
};

export default handler;
