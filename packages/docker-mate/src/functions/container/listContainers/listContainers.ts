import { RouteHandlerMethod } from 'fastify';

interface ContainerDetails {
  Id: string;
  Name: string;
  Image: string;
  Config: {
    AttachStderr: boolean;
    AttachStdin: boolean;
    AttachStdout: boolean;
    Cmd: string[];
    Domainname: string;
    Env: string[];
    Hostname: string;
    Image: string;
    Labels: Record<string, string>;
    MacAddress: string;
    NetworkDisabled: boolean;
    OpenStdin: boolean;
    StdinOnce: boolean;
    Tty: boolean;
    User: string;
    Volumes: Record<string, any>;
    WorkingDir: string;
    StopSignal: string;
    StopTimeout: number;
  };
  State: {
    Error: string;
    ExitCode: number;
    FinishedAt: string;
    OOMKilled: boolean;
    Dead: boolean;
    Paused: boolean;
    Pid: number;
    Restarting: boolean;
    Running: boolean;
    StartedAt: string;
    Status: string;
  };
}

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    // Use all: true to show all containers (not just running ones)
    const containerList = await req.server.docker.listContainers({ all: true });
    
    req.log.info(`Successfully listed ${containerList.length} containers`);

    // Get detailed information for each container
    const detailedContainers = await Promise.all(
      containerList.map(async (containerInfo) => {
        try {
          const container = req.server.docker.getContainer(containerInfo.Id);
          const details = await container.inspect();
          
          // Extract only the fields we need
          return {
            Id: details.Id,
            Name: details.Name.replace(/^\//, ''), // Remove leading slash from name
            Image: details.Config.Image,
            Config: {
              AttachStderr: details.Config.AttachStderr,
              AttachStdin: details.Config.AttachStdin,
              AttachStdout: details.Config.AttachStdout,
              Cmd: details.Config.Cmd || [],
              Domainname: details.Config.Domainname,
              Env: details.Config.Env || [],
              Hostname: details.Config.Hostname,
              Image: details.Config.Image,
              Labels: details.Config.Labels || {},
              MacAddress: (details.Config as any).MacAddress || '',
              NetworkDisabled: (details.Config as any).NetworkDisabled || false,
              OpenStdin: details.Config.OpenStdin,
              StdinOnce: details.Config.StdinOnce,
              Tty: details.Config.Tty,
              User: details.Config.User,
              Volumes: details.Config.Volumes || {},
              WorkingDir: details.Config.WorkingDir,
              StopSignal: (details.Config as any).StopSignal || 'SIGTERM',
              StopTimeout: (details.Config as any).StopTimeout || 10
            },
            State: details.State ? {
              Error: details.State.Error || '',
              ExitCode: details.State.ExitCode,
              FinishedAt: details.State.FinishedAt,
              OOMKilled: details.State.OOMKilled,
              Dead: details.State.Dead,
              Paused: details.State.Paused,
              Pid: details.State.Pid,
              Restarting: details.State.Restarting,
              Running: details.State.Running,
              StartedAt: details.State.StartedAt,
              Status: details.State.Status
            } : {}
          };
        } catch (inspectError) {
          req.log.error(`Error inspecting container ${containerInfo.Id}: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`);
          // Return basic info if inspect fails
          return {
            Id: containerInfo.Id,
            Name: containerInfo.Names[0]?.replace(/^\//, '') || '',
            Image: containerInfo.Image,
            Config: {
              AttachStderr: false,
              AttachStdin: false,
              AttachStdout: false,
              Cmd: [],
              Domainname: '',
              Env: [],
              Hostname: '',
              Image: containerInfo.Image,
              Labels: containerInfo.Labels || {},
              MacAddress: '',
              NetworkDisabled: false,
              OpenStdin: false,
              StdinOnce: false,
              Tty: false,
              User: '',
              Volumes: {},
              WorkingDir: '',
              StopSignal: 'SIGTERM',
              StopTimeout: 10
            },
            State: {
              Error: '',
              ExitCode: 0,
              FinishedAt: '',
              OOMKilled: false,
              Dead: false,
              Paused: false,
              Pid: 0,
              Restarting: false,
              Running: containerInfo.State === 'running',
              StartedAt: '',
              Status: containerInfo.State
            }
          };
        }
      })
    );

    // Ensure proper serialization of objects
    const sanitizedContainers = detailedContainers.map(container => {
      return {
        ...container,
        State: container.State ? {
          Error: container.State.Error || '',
          ExitCode: typeof container.State.ExitCode === 'number' ? container.State.ExitCode : 0,
          FinishedAt: container.State.FinishedAt || '',
          OOMKilled: !!container.State.OOMKilled,
          Dead: !!container.State.Dead,
          Paused: !!container.State.Paused,
          Pid: typeof container.State.Pid === 'number' ? container.State.Pid : 0,
          Restarting: !!container.State.Restarting,
          Running: !!container.State.Running,
          StartedAt: container.State.StartedAt || '',
          Status: container.State.Status || ''
        } : {
          Error: '',
          ExitCode: 0,
          FinishedAt: '',
          OOMKilled: false,
          Dead: false,
          Paused: false,
          Pid: 0,
          Restarting: false,
          Running: false,
          StartedAt: '',
          Status: ''
        }
      };
    });

    reply.statusCode = 200;
    reply.send({ success: true, data: sanitizedContainers });
  } catch (error) {
    req.log.error(`Error listing containers: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
    
    // Try to diagnose the issue
    try {
      // Check if Docker is accessible at all
      await req.server.docker.ping();
      req.log.info('Docker daemon is responding to ping');
    } catch (pingError) {
      req.log.error(`Docker daemon ping failed: ${pingError instanceof Error ? pingError.message : String(pingError)}`);
    }
    
    reply.statusCode = 500;
    reply.send({ 
      success: false, 
      error: 'Failed to list containers', 
      details: error instanceof Error ? error.message : String(error) 
    });
  }
};

export default handler;
