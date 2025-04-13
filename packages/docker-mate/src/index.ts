import fastify from 'fastify';
import Docker from 'dockerode';

import dockerPlugin from './plugins/docker';
import swaggerPlugin from './plugins/swagger';
import gluesyncPlugin from './plugins/gluesync';

import composeToJSON from './functions/composeToJSON/composeToJSON';
import info from './functions/info/info';
import version from './functions/version/version';
import listContainers from './functions/container/listContainers/listContainers';
import getContainerVersion from './functions/container/getContainerVersion/getContainerVersion';
import getContainer from './functions/container/getContainer/getContainer';
import updateContainer from './functions/container/updateContainer/updateContainer';
import addContainer from './functions/container/addContainer/addContainer';
import addAgent from './functions/agent/addAgent/addAgent';

import removeAgent from './functions/agent/removeAgent/removeAgent';
import startAgents from './functions/agent/startAgents/startAgents';
import stopAgents from './functions/agent/stopAgents/stopAgents';

declare module 'fastify' {
  interface FastifyInstance {
    docker: Docker;
    gluesyncSdk: any; // Using any type for the simplified SDK client
  }
}

const fastifyLogger: boolean = process.env.DEBUG === 'true';
const port: number = process.env.PORT ? parseInt(process.env.PORT) : 50000;

const server = fastify({
  logger: fastifyLogger,
  ignoreTrailingSlash: true, // Handle URLs with trailing slashes
  ajv: {
    customOptions: {
      strict: false,
      removeAdditional: false
    }
  }
});

// Register Docker plugin
server.register(dockerPlugin);

// Register Swagger UI plugin
server.register(swaggerPlugin);

// Register Gluesync SDK plugin
server.register(gluesyncPlugin);

// Add hook to log when server is ready
server.addHook('onReady', () => {
  console.log('Gluesync Conductor API is running');
  console.log(`Swagger UI is available at http://localhost:${port}/docs`);
});

server.get('/health', {
  schema: {
    tags: ['system'],
    description: 'Health check endpoint',
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'string' }
        }
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' }
        }
      }
    }
  },
  handler: async (req, reply) => {
    try {
      req.log.info('Health check OK!');
      reply.send({ success: true, data: 'Health check OK!' });
    } catch (error) {
      req.log.error('Error:', error);
      reply.status(500).send({ success: false, error: 'Health check failed' });
    }
  }
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
          data: { type: 'object' }
        }
      }
    }
  },
  handler: composeToJSON
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
          data: { type: 'object' }
        }
      }
    }
  },
  handler: info
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
          data: { type: 'string' }
        }
      }
    }
  },
  handler: version
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
            type: 'array',
            items: {
              type: 'object',
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
                ports: { type: 'array', items: { type: 'object', additionalProperties: true } },
                mounts: { type: 'array', items: { type: 'object', additionalProperties: true } }
              },
              additionalProperties: true
            }
          }
        }
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
          details: { type: 'string' }
        }
      }
    }
  },
  handler: listContainers
});

server.get('/containers/:id', {
  schema: {
    description: 'Get a container configuration',
    tags: ['containers'],
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container ID' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
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
              volumes: { type: 'array', items: { type: 'string' } }
            }
          }
        }
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' }
        }
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' }
        }
      }
    }
  },
  handler: getContainer
});

server.get('/containers/:id/version', {
  schema: {
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Container ID' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'object',
            properties: {
              containerId: { type: 'string' },
              containerName: { type: 'string' },
              currentImage: { type: 'string' },
              currentTag: { type: 'string' },
              latestVersion: { type: 'object', additionalProperties: true }
            }
          }
        }
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' }
        }
      },
      502: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' }
        }
      }
    }
  },
  handler: getContainerVersion
});

server.post('/containers', {
  schema: {
    tags: ['containers'],
    description: 'Add new containers to the system',
    body: {
      type: 'object',
      properties: {
        containers: {
          type: 'array',
          items: {
            type: 'object',
            required: ['imageName', 'type'],
            properties: {
              imageName: { type: 'string', description: 'Name of the Docker image' },
              type: { type: 'string', enum: ['target', 'source'], description: 'Type of the agent' },
              nickname: { type: 'string', description: 'Optional nickname for the container' },
              tag: { type: 'string', description: 'Optional Docker image tag' },
              environment: { type: 'object', additionalProperties: true, description: 'Optional environment variables' },
              ports: { type: 'array', items: { type: 'string' }, description: 'Optional port mappings' },
              volumes: { type: 'array', items: { type: 'string' }, description: 'Optional volume mappings' }
            }
          }
        }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'object' }
        }
      },
      400: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' }
        }
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' }
        }
      }
    }
  },
  handler: addContainer
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
          data: { type: 'object' },
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
          data: { type: 'array', items: { type: 'string' } },
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
          data: { type: 'array', items: { type: 'string' } },
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
        type: { type: 'string', enum: ['target', 'source'], description: 'Type of the agent' },
        nickname: { type: 'string', description: 'Optional nickname for the agent' },
        tag: { type: 'string', description: 'Optional Docker image tag' },
        environment: { type: 'object', additionalProperties: true, description: 'Optional environment variables' },
        ports: { type: 'array', items: { type: 'string' }, description: 'Optional port mappings' },
        volumes: { type: 'array', items: { type: 'string' }, description: 'Optional volume mappings' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'object', additionalProperties: true }
        }
      },
      404: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' }
        }
      },
      500: {
        type: 'object',
        properties: {
          success: { type: 'boolean', default: false },
          error: { type: 'string' }
        }
      }
    }
  },
  handler: updateContainer,
});

// Run the server!
process.on('unhandledRejection', (err) => {
  console.error(err);
  process.exit(1);
});

server.listen({ host: '0.0.0.0', port }, (err) => {
  if (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
  console.log(`Gluesync Conductor server started on port ${port}`);
});
