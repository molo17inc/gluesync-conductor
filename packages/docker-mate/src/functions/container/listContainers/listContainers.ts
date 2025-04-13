import { RouteHandlerMethod } from 'fastify';

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
        const containerDetails = {
          Id: details.Id,
          Name: details.Name ? details.Name.replace(/^\//, '') : '',
          Image: details.Config?.Image || '',
          Created: details.Created || '',
          // Extract State fields directly
          Running: details.State?.Running || false,
          Status: details.State?.Status || '',
          ExitCode: details.State?.ExitCode || 0,
          StartedAt: details.State?.StartedAt || '',
          FinishedAt: details.State?.FinishedAt || '',
          // Extract Config fields directly
          Cmd: details.Config?.Cmd || [],
          Env: details.Config?.Env || [],
          Labels: details.Config?.Labels || {},
          // Extract HostConfig fields directly
          NetworkMode: details.HostConfig?.NetworkMode || '',
          Privileged: details.HostConfig?.Privileged || false,
          // Include other important fields
          Ports: containerInfo.Ports || [],
          Mounts: details.Mounts || []
        };
        
        // Add the container details to our array
        containers.push(containerDetails);
      } catch (inspectError) {
        req.log.error(`Error inspecting container ${containerInfo.Id}: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`);
        // Return basic info if inspect fails
        containers.push({
          Id: containerInfo.Id,
          Name: containerInfo.Names?.[0]?.replace(/^\//, '') || '',
          Image: containerInfo.Image || '',
          Created: containerInfo.Created || '',
          Running: containerInfo.State === 'running',
          Status: containerInfo.State || '',
          ExitCode: 0,
          StartedAt: '',
          FinishedAt: '',
          Cmd: [],
          Env: [],
          Labels: containerInfo.Labels || {},
          NetworkMode: 'default',
          Privileged: false,
          Ports: containerInfo.Ports || [],
          Mounts: []
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
