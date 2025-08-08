import fastify from 'fastify';
import Docker from 'dockerode';

import dockerPlugin from './plugins/docker';
import swaggerPlugin from './plugins/swagger';
import gluesyncPlugin from './plugins/gluesync';
import httpsRedirectMiddleware from './middleware/httpsRedirect';
import {
  createFastifyHttpsOptions,
  isSslEnabled,
  logSslInfo,
} from './utils/ssl';

import composeToJSON from './functions/composeToJSON/composeToJSON';
import info from './functions/info/info';
import version from './functions/version/version';
import listContainers from './functions/container/listContainers/listContainers';
import getContainerVersion from './functions/container/getContainerVersion/getContainerVersion';
import getContainer from './functions/container/getContainer/getContainer';
import updateContainer from './functions/container/updateContainer/updateContainer';
import addAgents from './functions/agent/addAgents/addAgents';
import getAgents from './functions/agent/getAgents/getAgents';
import removeAgent from './functions/agent/removeAgent/removeAgent';
import startAgents from './functions/agent/startAgents/startAgents';
import stopAgents from './functions/agent/stopAgents/stopAgents';
import pullContainer from './functions/container/pullContainer/pullContainer';
import restartContainer from './functions/container/restartContainer/restartContainer';

// These imports are already defined earlier in the file

// Type imports will be handled directly in the route handlers

declare module 'fastify' {
  interface FastifyInstance {
    docker: Docker;
    gluesyncSdk: any; // Using any type for the simplified SDK client
  }
}

const port: number = process.env.PORT ? parseInt(process.env.PORT, 10) : 50000;
const host: string = process.env.HOST || '0.0.0.0';

// Create server with HTTPS support if SSL is enabled
const serverOptions = createFastifyHttpsOptions();
const server = fastify(serverOptions);

// Log SSL information if enabled
logSslInfo();

// Register HTTPS redirect middleware
httpsRedirectMiddleware(server);

// Register Docker plugin
server.register(dockerPlugin);

// Register Swagger UI plugin
server.register(swaggerPlugin);

// Register Gluesync SDK plugin
server.register(gluesyncPlugin);

server.get('/health', {
  schema: {
    tags: ['system'],
    description: 'Health check endpoint',
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'string' },
        },
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: async (req, reply) => {
    try {
      req.log.debug('Health check OK!');
      reply.send({ success: true, data: 'Health check OK!' });
    } catch (error) {
      req.log.error('Error:', error);
      reply.status(500).send({ success: false, error: 'Health check failed' });
    }
  },
});

server.get('/compose-to-json', {
  schema: {
    tags: ['system'],
    description: 'Convert compose file to JSON',
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'object',
          },
        },
      },
    },
  },
  handler: composeToJSON,
});

server.get('/info', {
  schema: {
    tags: ['system'],
    description: 'Get system information',
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'object',
          },
        },
      },
    },
  },
  handler: info,
});

server.get('/version', {
  schema: {
    tags: ['system'],
    description: 'Get API version',
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'object',
          },
        },
      },
    },
  },
  handler: version,
});

server.get('/containers', {
  schema: {
    tags: ['containers'],
    description: 'List all containers',
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'object',
            properties: {
              systemInfo: {
                type: 'object',
                properties: {
                  ncpu: { type: 'number' },
                  memTotal: { type: 'number' },
                },
              },
              containers: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: true, // Allow any properties in the response
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    image: { type: 'string' },
                    tag: { type: 'string' },
                    versionTag: { type: 'string' },
                    persisted: { type: 'boolean' },
                    created: { type: 'string' },
                    running: { type: 'boolean' },
                    status: { type: 'string' },
                    exitCode: { type: 'number' },
                    startedAt: { type: 'string' },
                    finishedAt: { type: 'string' },
                    cmd: { type: 'array', items: { type: 'string' } },
                    env: { type: 'array', items: { type: 'string' } },
                    labels: { type: 'object', additionalProperties: true },
                    networkMode: { type: 'string' },
                    privileged: { type: 'boolean' },
                    ports: {
                      type: 'array',
                      items: { type: 'object', additionalProperties: true },
                    },
                    mounts: {
                      type: 'array',
                      items: { type: 'object', additionalProperties: true },
                    },
                    hostConfig: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
        },
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
          details: { type: 'string' },
        },
      },
    },
  },
  handler: listContainers,
});

server.get('/containers/:id', {
  schema: {
    description: 'Get a container configuration',
    tags: ['containers'],
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container ID' },
      },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'object',
            properties: {
              imageName: { type: 'string' },
              type: { type: 'string', enum: ['target', 'source'] },
              nickname: { type: 'string' },
              tag: { type: 'string' },
              versionTag: { type: 'string' },
              persisted: { type: 'boolean' },
              environment: { type: 'object', additionalProperties: true },
              ports: { type: 'array', items: { type: 'string' } },
              volumes: { type: 'array', items: { type: 'string' } },
              hostConfig: { type: 'object', additionalProperties: true },
            },
          },
          systemInfo: {
            type: 'object',
            properties: {
              ncpu: { type: 'number' },
              memTotal: { type: 'number' },
            },
          },
        },
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: getContainer,
});

server.get('/containers/:id/version', {
  schema: {
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container ID' },
      },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'object',
            properties: {
              containerId: { type: 'string' },
              containerName: { type: 'string' },
              currentImage: { type: 'string' },
              currentTag: { type: 'string' },
              latestVersion: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      502: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: getContainerVersion,
});

server.delete('/containers/:id', {
  schema: {
    description: 'Remove a container from the compose file',
    tags: ['containers'],
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container ID to remove' },
      },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'object',
          },
        },
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: removeAgent,
});

server.post('/agents', {
  schema: {
    description: 'add a agents ',
    tags: ['agents'],
    body: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              imageName: { type: 'string' },
              type: { type: 'string', enum: ['target', 'source'] },
              name: { type: 'string' },
              tag: { type: 'string' },
              environment: {
                type: 'object',
                additionalProperties: true,
              },
              ports: {
                type: 'array',
                items: { type: 'string' },
              },
              volumes: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['imageName', 'type'],
          },
        },
      },
      required: ['agents'],
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'object',
          },
        },
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: addAgents,
});

server.post('/containers/:id/start', {
  schema: {
    description: 'Start a container',
    tags: ['containers'],
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container ID to start' },
      },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: startAgents,
});

// Register ComposeFile schema for Fastify to use in route responses
server.addSchema({
  $id: 'ComposeFile',
  additionalProperties: true, // Allow any properties in the response
  type: 'object',
  properties: {
    name: { type: 'string' },
    services: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          image: { type: 'string' },
          container_name: { type: 'string' },
          restart: { type: 'string' },
          environment: { type: 'array', items: { type: 'string' } },
          ports: { type: 'array', items: { type: 'string' } },
          volumes: { type: 'array', items: { type: 'string' } },
          labels: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
});

server.get('/agents', {
  schema: {
    description:
      'Get all agents (containers with type=source or type=target in environment)',
    tags: ['agents'],
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                imageName: { type: 'string' },
                type: { type: 'string', enum: ['target', 'source'] },
                nickname: { type: 'string' },
                tag: { type: 'string' },
                versionTag: { type: 'string' },
                persisted: { type: 'boolean' },
                environment: { type: 'array', items: { type: 'string' } },
                ports: {
                  type: 'array',
                  items: { type: 'object', additionalProperties: true },
                },
                volumes: { type: 'array', items: { type: 'string' } },
                hostConfig: { type: 'object', additionalProperties: true },
              },
            },
          },
          systemInfo: {
            type: 'object',
            properties: {
              ncpu: { type: 'number' },
              memTotal: { type: 'number' },
            },
          },
        },
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: getAgents,
});

server.post('/containers/:id/stop', {
  schema: {
    description: 'Stop a container',
    tags: ['containers'],
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container ID to stop' },
      },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: stopAgents,
});

// We already have the pullContainer import at the top of the file

// Register the pull container route
server.post('/containers/:id/pull', {
  schema: {
    description: 'Pull the latest image for a container',
    tags: ['containers'],
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container ID to pull image for' },
      },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: pullContainer,
});

// We already have the restartContainer import at the top of the file

// Register the restart container route
server.post('/containers/:id/restart', {
  schema: {
    description: 'Restart a container',
    tags: ['containers'],
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container ID to restart' },
      },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: restartContainer,
});

server.put('/containers/:id', {
  schema: {
    description: 'Update a container configuration',
    tags: ['containers'],
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container ID to update' },
      },
    },
    body: {
      type: 'object',
      properties: {
        imageName: { type: 'string', description: 'Name of the Docker image' },
        type: {
          type: 'string',
          enum: ['target', 'source'],
          description: 'Type of the agent',
        },
        nickname: {
          type: 'string',
          description: 'Optional nickname for the agent',
        },
        tag: { type: 'string', description: 'Optional Docker image tag' },
        environment: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional environment variables',
        },
        ports: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional port mappings',
        },
        volumes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional volume mappings',
        },
      },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            additionalProperties: true, // Allow any properties in the response
            type: 'object',
          },
        },
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' },
        },
      },
    },
  },
  handler: updateContainer,
});

// Handle unhandled rejections
process.on('unhandledRejection', err => {
  console.error(err);
  process.exit(1);
});

// Start the server
server.listen({ host, port }, err => {
  if (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }

  // Log server startup information
  const protocol = isSslEnabled() ? 'https' : 'http';
  console.info(
    `Swagger UI is available at ${protocol}://${host === '0.0.0.0' ? 'localhost' : host}:${port}/docs`,
  );
  console.info(`Gluesync Conductor server started on port ${port}`);
});
